import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join, relative, sep } from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'
import { pathToFileURL } from 'node:url'

const probeRoot = await mkdtemp(join(tmpdir(), 'praxis-package-'))
const commandTimeoutMs = 2 * 60 * 1_000
const commandTerminationGraceMs = 1_000
const maxCommandOutputBytes = 4 * 1024 * 1024
const maxPackageBytes = 1024 * 1024
const maxUnpackedBytes = 4 * 1024 * 1024
const maxProviderRequestBytes = 1024 * 1024

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32'
    const child = spawn(file, args, {
      ...options,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let stopReason
    let spawnError
    let closeResult
    let escalationComplete = false
    let forceTimer

    const terminate = (signal) => {
      if (detached && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal)
          return
        } catch (error) {
          if (error?.code !== 'ESRCH') throw error
        }
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal)
      }
    }
    const finish = () => {
      if (closeResult === undefined || (stopReason && !escalationComplete)) {
        return
      }
      clearTimeout(timeoutTimer)
      clearTimeout(forceTimer)
      const [code, signal] = closeResult
      if (!spawnError && !stopReason && code === 0) {
        resolve({ stdout, stderr })
        return
      }
      const reason =
        stopReason ??
        (spawnError
          ? String(spawnError)
          : `exited with ${code === null ? `signal ${signal}` : `code ${code}`}`)
      reject(
        new Error(
          `${file} ${args.join(' ')} failed: ${reason}${stderr.trim() ? `\n${stderr.trim()}` : ''}`,
          spawnError ? { cause: spawnError } : undefined,
        ),
      )
    }
    const stop = (reason) => {
      if (stopReason) return
      stopReason = reason
      terminate('SIGTERM')
      forceTimer = setTimeout(() => {
        terminate('SIGKILL')
        escalationComplete = true
        finish()
      }, commandTerminationGraceMs)
    }
    const capture = (target) => (chunk) => {
      const remaining = maxCommandOutputBytes - outputBytes
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining).toString('utf8')
        if (target === 'stdout') stdout += retained
        else stderr += retained
      }
      outputBytes += chunk.length
      if (outputBytes > maxCommandOutputBytes) {
        stop(`output exceeded ${maxCommandOutputBytes} bytes`)
      }
    }
    const timeoutTimer = setTimeout(
      () => stop(`timed out after ${commandTimeoutMs}ms`),
      commandTimeoutMs,
    )

    child.stdout.on('data', capture('stdout'))
    child.stderr.on('data', capture('stderr'))
    child.on('error', (error) => {
      spawnError = error
    })
    child.on('close', (code, signal) => {
      closeResult = [code, signal]
      finish()
    })
  })
}

async function listReleaseFiles(root) {
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile())
        files.push(relative(root, path).split(sep).join('/'))
      else throw new Error(`Unsupported release file type: ${path}`)
    }
  }
  await visit(root)
  return files.sort()
}

function assertPackageContents(files, distFiles) {
  const expected = new Set([
    'LICENSE',
    'README.md',
    'package.json',
    ...distFiles,
  ])
  const allowedDistSuffixes = ['.js', '.js.map', '.d.ts', '.d.ts.map']
  for (const path of distFiles) {
    if (
      !allowedDistSuffixes.some((suffix) => path.endsWith(suffix)) ||
      /\.(?:spec|test)\./u.test(path)
    ) {
      throw new Error(`Unexpected dist release file: ${path}`)
    }
  }
  for (const { path } of files) {
    if (!expected.delete(path)) {
      throw new Error(`Unexpected release package file: ${path}`)
    }
  }
  if (expected.size > 0) {
    throw new Error(
      `Release package is missing: ${[...expected].sort().join(', ')}`,
    )
  }
}

async function expectRejected(action, message) {
  try {
    await action()
  } catch (error) {
    if (String(error).includes(message)) return
    throw error
  }
  throw new Error(`Expected rejection containing ${message}`)
}

function parseJsonLines(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function resultFrom(output) {
  const result = parseJsonLines(output).findLast(
    (entry) => entry?.type === 'result',
  )
  if (!result) throw new Error(`Installed CLI returned no result: ${output}`)
  return result
}

function findMessage(messages, start, predicate, description) {
  const offset = messages.slice(start).findIndex(predicate)
  if (offset < 0) throw new Error(`Provider request omitted ${description}`)
  return start + offset
}

function matchesToolCall(message, expected) {
  if (
    message?.role !== 'assistant' ||
    !Array.isArray(message.tool_calls) ||
    message.tool_calls.length !== 1
  ) {
    return false
  }
  const call = message.tool_calls.find(
    (candidate) =>
      candidate?.type === 'function' &&
      candidate?.id === expected.id &&
      candidate?.function?.name === expected.name,
  )
  if (!call) return false
  try {
    const input = JSON.parse(call.function.arguments)
    const expectedEntries = Object.entries(expected.input)
    return (
      input !== null &&
      typeof input === 'object' &&
      !Array.isArray(input) &&
      Object.keys(input).length === expectedEntries.length &&
      expectedEntries.every(([key, value]) => input[key] === value)
    )
  } catch {
    return false
  }
}

function assertToolExchange(messages, start, expected) {
  const assistantIndex = findMessage(
    messages,
    start,
    (message) => matchesToolCall(message, expected),
    `${expected.name} assistant tool call ${expected.id}`,
  )
  if (assistantIndex !== start) {
    throw new Error(`Provider request reordered ${expected.name} tool call`)
  }
  const resultIndex = findMessage(
    messages,
    assistantIndex + 1,
    (message) =>
      message?.role === 'tool' &&
      message?.tool_call_id === expected.id &&
      message?.is_error !== true &&
      String(message?.content).includes(expected.marker),
    `${expected.name} tool result ${expected.id}`,
  )
  if (resultIndex !== assistantIndex + 1) {
    throw new Error(`Provider request reordered ${expected.name} tool result`)
  }
  return resultIndex + 1
}

function assertConversationEnd(messages, cursor, stage) {
  if (cursor !== messages.length) {
    throw new Error(`Provider request appended unexpected ${stage} messages`)
  }
}

function assertProviderConversation(messages, stage) {
  const firstConversationIndex = messages.findIndex(
    (message) => message?.role !== 'system',
  )
  if (
    firstConversationIndex < 0 ||
    messages[firstConversationIndex]?.role !== 'user' ||
    messages[firstConversationIndex]?.content !== 'read the release fixture'
  ) {
    throw new Error('Provider request has an invalid initial user prompt')
  }
  let cursor = firstConversationIndex + 1
  cursor = assertToolExchange(messages, cursor, {
    id: 'release_read',
    name: 'Read',
    input: { file_path: 'release-fixture.txt' },
    marker: 'RELEASE_TOOL_MARKER',
  })
  if (stage === 'read') {
    assertConversationEnd(messages, cursor, stage)
    return
  }
  cursor = assertToolExchange(messages, cursor, {
    id: 'release_permission',
    name: 'Bash',
    input: { command: "sed -n '1p' release-permission.txt" },
    marker: 'RELEASE_PERMISSION_MARKER',
  })
  if (stage === 'tools') {
    assertConversationEnd(messages, cursor, stage)
    return
  }
  const assistantIndex = findMessage(
    messages,
    cursor,
    (message) =>
      message?.role === 'assistant' &&
      message?.content === 'installed tool loop response',
    'final assistant response',
  )
  if (assistantIndex !== cursor) {
    throw new Error('Provider request reordered final assistant response')
  }
  const resumeIndex = findMessage(
    messages,
    assistantIndex + 1,
    (message) =>
      message?.role === 'user' && message?.content === 'release resume prompt',
    'resume user prompt',
  )
  if (resumeIndex !== assistantIndex + 1) {
    throw new Error('Provider request reordered resume user prompt')
  }
  assertConversationEnd(messages, resumeIndex + 1, stage)
}

function readProviderRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > maxProviderRequestBytes) {
        reject(
          new Error(
            `Provider request exceeded ${maxProviderRequestBytes} bytes`,
          ),
        )
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function sendOpenAIEvents(response, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of events)
    response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.end('data: [DONE]\n\n')
}

function sendAnthropicEvents(response, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of events) {
    response.write(`event: ${event.type}\n`)
    response.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  response.end()
}

function hasToolSchema(tools, name, requiredProperty) {
  const tool = tools.find(
    (candidate) =>
      candidate?.type === 'function' && candidate?.function?.name === name,
  )
  const parameters = tool?.function?.parameters
  return (
    typeof tool?.function?.description === 'string' &&
    parameters?.type === 'object' &&
    parameters?.properties?.[requiredProperty]?.type === 'string' &&
    Array.isArray(parameters?.required) &&
    parameters.required.includes(requiredProperty)
  )
}

function hasAnthropicToolSchema(tools, name, requiredProperty) {
  const tool = tools.find((candidate) => candidate?.name === name)
  const inputSchema = tool?.input_schema
  return (
    typeof tool?.description === 'string' &&
    inputSchema?.type === 'object' &&
    inputSchema?.properties?.[requiredProperty]?.type === 'string' &&
    Array.isArray(inputSchema?.required) &&
    inputSchema.required.includes(requiredProperty)
  )
}

function normalizeAnthropicMessages(messages) {
  const normalized = []
  let expectedRole = 'user'
  for (const message of messages) {
    if (
      (message?.role !== 'user' && message?.role !== 'assistant') ||
      message.role !== expectedRole ||
      !Array.isArray(message.content) ||
      message.content.length === 0
    ) {
      throw new Error('Installed CLI sent invalid Anthropic message roles')
    }
    expectedRole = expectedRole === 'user' ? 'assistant' : 'user'
    if (message.role === 'assistant') {
      if (
        message.content.some(
          (block) => block?.type !== 'text' && block?.type !== 'tool_use',
        )
      ) {
        throw new Error('Installed CLI sent invalid Anthropic assistant blocks')
      }
      const text = message.content
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('')
      const toolCalls = message.content
        .filter((block) => block?.type === 'tool_use')
        .map((block) => ({
          type: 'function',
          id: block.id,
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        }))
      normalized.push({
        role: 'assistant',
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
      continue
    }
    for (const block of message.content) {
      if (block?.type === 'text') {
        normalized.push({ role: 'user', content: block.text })
      } else if (block?.type === 'tool_result') {
        if (block.is_error !== false) {
          throw new Error(
            'Installed CLI marked a successful Anthropic tool result as failed',
          )
        }
        normalized.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: block.content,
          is_error: block.is_error,
        })
      } else {
        throw new Error('Installed CLI sent invalid Anthropic user blocks')
      }
    }
  }
  return normalized
}

async function startProviderProbe(provider) {
  const requests = []
  let failure
  const server = createServer(async (request, response) => {
    try {
      const expectedPath =
        provider === 'anthropic' ? '/v1/messages' : '/v1/chat/completions'
      if (request.method !== 'POST' || request.url !== expectedPath) {
        response.writeHead(404).end()
        return
      }
      const authorized =
        provider === 'anthropic'
          ? request.headers['x-api-key'] === 'release-probe-key' &&
            request.headers['anthropic-version'] === '2023-06-01'
          : request.headers.authorization === 'Bearer release-probe-key'
      if (!authorized) {
        throw new Error('Installed CLI sent unexpected provider authorization')
      }
      const body = await readProviderRequest(request)
      if (
        body?.model !== 'release-probe-model' ||
        body?.stream !== true ||
        !Array.isArray(body?.messages)
      ) {
        throw new Error('Installed CLI sent an invalid provider request')
      }
      requests.push(body)
      const messages =
        provider === 'anthropic'
          ? normalizeAnthropicMessages(body.messages)
          : body.messages
      if (requests.length === 1) {
        if (
          messages.slice(0, -1).some((message) => message?.role !== 'system') ||
          messages.at(-1)?.role !== 'user' ||
          messages.at(-1)?.content !== 'read the release fixture'
        ) {
          throw new Error('Installed CLI omitted the initial user prompt')
        }
        const hasSchemas =
          provider === 'anthropic'
            ? Array.isArray(body.tools) &&
              hasAnthropicToolSchema(body.tools, 'Read', 'file_path') &&
              hasAnthropicToolSchema(body.tools, 'Bash', 'command')
            : Array.isArray(body.tools) &&
              hasToolSchema(body.tools, 'Read', 'file_path') &&
              hasToolSchema(body.tools, 'Bash', 'command')
        if (
          !hasSchemas ||
          (provider === 'anthropic' && body.max_tokens !== 1024)
        ) {
          throw new Error('Installed CLI omitted local tool schemas')
        }
        if (provider === 'anthropic') {
          sendAnthropicEvents(response, [
            {
              type: 'message_start',
              message: { usage: { input_tokens: 8 } },
            },
            {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'release_read',
                name: 'Read',
                input: {},
              },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'input_json_delta',
                partial_json: '{"file_path":"release-fixture.txt"}',
              },
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use', stop_sequence: null },
              usage: { output_tokens: 4 },
            },
            { type: 'message_stop' },
          ])
        } else {
          sendOpenAIEvents(response, [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'release_read',
                        type: 'function',
                        function: {
                          name: 'Read',
                          arguments: '{"file_path":"release-fixture.txt"}',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
            {
              choices: [],
              usage: { prompt_tokens: 8, completion_tokens: 4 },
            },
          ])
        }
        return
      }
      if (requests.length === 2) {
        assertProviderConversation(messages, 'read')
        if (provider === 'anthropic') {
          sendAnthropicEvents(response, [
            {
              type: 'message_start',
              message: { usage: { input_tokens: 8 } },
            },
            {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'release_permission',
                name: 'Bash',
                input: {},
              },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'input_json_delta',
                partial_json:
                  '{"command":"sed -n \'1p\' release-permission.txt"}',
              },
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use', stop_sequence: null },
              usage: { output_tokens: 4 },
            },
            { type: 'message_stop' },
          ])
        } else {
          sendOpenAIEvents(response, [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'release_permission',
                        type: 'function',
                        function: {
                          name: 'Bash',
                          arguments:
                            '{"command":"sed -n \'1p\' release-permission.txt"}',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
            {
              choices: [],
              usage: { prompt_tokens: 8, completion_tokens: 4 },
            },
          ])
        }
        return
      }
      if (requests.length === 3) {
        assertProviderConversation(messages, 'tools')
        if (provider === 'anthropic') {
          sendAnthropicEvents(response, [
            {
              type: 'message_start',
              message: { usage: { input_tokens: 8 } },
            },
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'text_delta',
                text: 'installed tool loop response',
              },
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 4 },
            },
            { type: 'message_stop' },
          ])
        } else {
          sendOpenAIEvents(response, [
            {
              choices: [{ delta: { content: 'installed tool loop response' } }],
            },
            {
              choices: [],
              usage: { prompt_tokens: 8, completion_tokens: 4 },
            },
          ])
        }
        return
      }
      if (requests.length === 4) {
        assertProviderConversation(messages, 'resume')
        if (provider === 'anthropic') {
          sendAnthropicEvents(response, [
            {
              type: 'message_start',
              message: { usage: { input_tokens: 8 } },
            },
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'text_delta',
                text: 'installed resume response',
              },
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 4 },
            },
            { type: 'message_stop' },
          ])
        } else {
          sendOpenAIEvents(response, [
            {
              choices: [{ delta: { content: 'installed resume response' } }],
            },
            {
              choices: [],
              usage: { prompt_tokens: 8, completion_tokens: 4 },
            },
          ])
        }
        return
      }
      throw new Error(`Unexpected provider request ${requests.length}`)
    } catch (error) {
      failure ??= error
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' })
      }
      response.end(JSON.stringify({ error: { message: String(error) } }))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Provider probe has no TCP address')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    assertComplete() {
      if (failure) throw failure
      if (requests.length !== 4) {
        throw new Error(`Provider probe received ${requests.length} requests`)
      }
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

let providerProbe
try {
  const repositoryRoot = process.cwd()
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
  )
  if (manifest.private === true) {
    throw new Error('Release package must not be private')
  }
  if (manifest.license !== 'MIT') {
    throw new Error(`Unexpected package license: ${String(manifest.license)}`)
  }
  const distFiles = await listReleaseFiles(join(repositoryRoot, 'dist'))
  if (!distFiles.includes('cli.js') || !distFiles.includes('cli.d.ts')) {
    throw new Error('Built release is missing CLI entry files')
  }
  const packagedDistFiles = distFiles.map((path) => `dist/${path}`)

  const packRoot = join(probeRoot, 'pack')
  await mkdir(packRoot, { recursive: true })
  const { stdout: packOutput } = await run(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', packRoot],
    { cwd: repositoryRoot },
  )
  const [packed] = JSON.parse(packOutput)
  if (
    !packed ||
    packed.name !== manifest.name ||
    packed.version !== manifest.version
  ) {
    throw new Error(`Unexpected npm pack result: ${packOutput}`)
  }
  assertPackageContents(packed.files, packagedDistFiles)
  if (packed.size > maxPackageBytes) {
    throw new Error(
      `Release package exceeded ${maxPackageBytes} bytes: ${packed.size}`,
    )
  }
  if (packed.unpackedSize > maxUnpackedBytes) {
    throw new Error(
      `Unpacked release exceeded ${maxUnpackedBytes} bytes: ${packed.unpackedSize}`,
    )
  }

  const tarball = join(packRoot, packed.filename)
  await access(tarball)
  const installRoot = join(probeRoot, 'install')
  await mkdir(installRoot, { recursive: true })
  await writeFile(
    join(installRoot, 'package.json'),
    `${JSON.stringify({ private: true })}\n`,
  )
  await run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      tarball,
    ],
    { cwd: installRoot },
  )

  const installedPackage = join(installRoot, 'node_modules', manifest.name)
  const installedManifest = JSON.parse(
    await readFile(join(installedPackage, 'package.json'), 'utf8'),
  )
  if (installedManifest.version !== manifest.version) {
    throw new Error('Installed tarball version does not match package manifest')
  }
  await access(join(installedPackage, 'dist', 'cli.js'))

  const praxis = join(installRoot, 'node_modules', '.bin', 'praxis')
  const version = await run(praxis, ['--version'], { cwd: installRoot })
  if (version.stdout.trim() !== manifest.version) {
    throw new Error(`Installed CLI returned ${version.stdout.trim()}`)
  }
  const help = await run(praxis, ['--help'], { cwd: installRoot })
  if (!help.stdout.includes('Usage:\n  praxis')) {
    throw new Error('Installed CLI help is unavailable')
  }

  const fakeBin = join(probeRoot, 'bin')
  const configRoot = join(probeRoot, 'claude-config')
  const workDirectory = join(probeRoot, 'work')
  await mkdir(fakeBin, { recursive: true })
  await mkdir(configRoot, { recursive: true })
  await mkdir(workDirectory, { recursive: true })
  await writeFile(
    join(fakeBin, 'claude'),
    "#!/bin/sh\nprintf '2.1.208 (Claude Code)\\n'\n",
    { mode: 0o755 },
  )
  const sessions = await run(praxis, ['sessions', '--json'], {
    cwd: workDirectory,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configRoot,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
    },
  })
  const sessionResult = JSON.parse(sessions.stdout)
  if (
    sessionResult.type !== 'sessions' ||
    !Array.isArray(sessionResult.sessions) ||
    sessionResult.sessions.length !== 0
  ) {
    throw new Error(`Installed CLI session smoke failed: ${sessions.stdout}`)
  }

  await writeFile(
    join(configRoot, 'settings.json'),
    `${JSON.stringify({ permissions: { allow: ["Bash(sed -n '1p' release-permission.txt)"] } })}\n`,
  )
  await writeFile(
    join(workDirectory, 'release-fixture.txt'),
    'RELEASE_TOOL_MARKER\n',
  )
  await writeFile(
    join(workDirectory, 'release-permission.txt'),
    'RELEASE_PERMISSION_MARKER\n',
  )
  for (const provider of ['openai', 'anthropic']) {
    providerProbe = await startProviderProbe(provider)
    const providerEnvironment = {
      ...process.env,
      CLAUDE_CONFIG_DIR: configRoot,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      PRAXIS_PROVIDER: provider,
      PRAXIS_API_KEY: 'release-probe-key',
      PRAXIS_MODEL: 'release-probe-model',
      PRAXIS_BASE_URL: providerProbe.baseUrl,
      ...(provider === 'anthropic' ? { PRAXIS_MAX_OUTPUT_TOKENS: '1024' } : {}),
    }
    const installedRun = await run(
      praxis,
      ['run', '--json', 'read the release fixture'],
      { cwd: workDirectory, env: providerEnvironment },
    )
    const runResult = resultFrom(installedRun.stdout)
    if (runResult.text !== 'installed tool loop response') {
      throw new Error(
        `Installed ${provider} CLI tool loop returned ${runResult.text}`,
      )
    }
    if (
      runResult.usage?.inputTokens !== 24 ||
      runResult.usage?.outputTokens !== 12
    ) {
      throw new Error(
        `Installed ${provider} CLI returned invalid run usage ${JSON.stringify(runResult.usage)}`,
      )
    }
    const installedResume = await run(
      praxis,
      ['resume', '--json', runResult.sessionId, 'release resume prompt'],
      { cwd: workDirectory, env: providerEnvironment },
    )
    const resumeResult = resultFrom(installedResume.stdout)
    if (
      resumeResult.sessionId !== runResult.sessionId ||
      resumeResult.text !== 'installed resume response'
    ) {
      throw new Error(
        `Installed ${provider} CLI resume did not preserve the session`,
      )
    }
    if (
      resumeResult.usage?.inputTokens !== 8 ||
      resumeResult.usage?.outputTokens !== 4
    ) {
      throw new Error(
        `Installed ${provider} CLI returned invalid resume usage ${JSON.stringify(resumeResult.usage)}`,
      )
    }
    providerProbe.assertComplete()
    await providerProbe.close()
    providerProbe = undefined
  }

  const schemaModule = await import(
    pathToFileURL(
      join(installedPackage, 'dist', 'compatibility', 'claude', 'schema.js'),
    ).href
  )
  const sessionModule = await import(
    pathToFileURL(
      join(installedPackage, 'dist', 'application', 'session-service.js'),
    ).href
  )
  const versionMatrix = [
    ['2.1.208', 'read-write'],
    ['2.1.207', 'read-only'],
    ['2.1.209', 'read-only'],
    ['3.0.0', 'read-only'],
  ]
  for (const [claudeVersion, writeMode] of versionMatrix) {
    const adapter = schemaModule.selectClaudeSchemaAdapter(claudeVersion)
    if (adapter.writeMode !== writeMode) {
      throw new Error(
        `Claude ${claudeVersion} resolved ${adapter.writeMode}, expected ${writeMode}`,
      )
    }
    const entry = adapter.parse('{"type":"user","future":true}')
    if (entry.future !== true) {
      throw new Error(`Claude ${claudeVersion} read compatibility failed`)
    }
    const matrixConfigRoot = join(probeRoot, 'matrix', claudeVersion)
    const service = new sessionModule.ClaudeSessionService({
      configRoot: matrixConfigRoot,
      cwd: workDirectory,
      claudeVersion,
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta', delta: 'release matrix response' }
        },
      },
    })
    if (writeMode === 'read-write') {
      const result = await service.run('release matrix prompt')
      await service.fork(result.sessionId)
      const matrixSessions = await service.sessions()
      if (matrixSessions.length !== 2) {
        throw new Error(
          `Claude ${claudeVersion} write/fork matrix created ${matrixSessions.length} sessions`,
        )
      }
      continue
    }
    await expectRejected(
      () => Promise.resolve(adapter.serializeForAppend(entry)),
      'read-only mode',
    )
    await expectRejected(
      () => Promise.resolve(adapter.serializeForFork(entry)),
      'read-only mode',
    )
    await expectRejected(() => service.run('must stay read-only'), 'read-only')
    await expectRejected(() => service.fork('must-not-exist'), 'read-only')
    if ((await service.sessions()).length !== 0) {
      throw new Error(
        `Claude ${claudeVersion} read-only matrix wrote a session`,
      )
    }
  }

  console.log(
    `Praxis ${manifest.version} release package passed: ${packed.files.length} files, ${packed.size} compressed bytes, clean tarball install, installed OpenAI/Anthropic CLI provider/tool/resume loops, and Claude 2.1.207/2.1.208/2.1.209/3.0.0 write-safety matrix`,
  )
} finally {
  try {
    if (providerProbe) await providerProbe.close()
  } finally {
    await rm(probeRoot, { recursive: true })
  }
}
