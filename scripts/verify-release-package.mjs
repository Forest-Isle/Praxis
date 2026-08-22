import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, sep } from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'
import { pathToFileURL } from 'node:url'

const probeRoot = await mkdtemp(join(tmpdir(), 'praxis-package-'))
const commandTimeoutMs = 2 * 60 * 1_000
const commandTerminationGraceMs = 1_000
const maxCommandOutputBytes = 4 * 1024 * 1024
const maxPackageBytes = 1024 * 1024
const maxUnpackedBytes = 4 * 1024 * 1024
const maxProviderRequestBytes = 1024 * 1024
const ZERO_COST_SUMMARY =
  'Total cost:            $0.0000\n' +
  'Total duration (API):  0s\n' +
  'Total duration (wall): 0s\n' +
  'Total code changes:    0 lines added, 0 lines removed\n' +
  'Usage:                 0 input, 0 output, 0 cache read, 0 cache write'

async function assertMissing(path, label) {
  try {
    await access(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error(`${label} unexpectedly exists: ${path}`)
}

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { input, ...spawnOptions } = options
    const detached = process.platform !== 'win32'
    const child = spawn(file, args, {
      ...spawnOptions,
      detached,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    const stdoutChunks = []
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
        resolve({ stdout, stdoutBytes: Buffer.concat(stdoutChunks), stderr })
        return
      }
      const reason =
        stopReason ??
        (spawnError
          ? String(spawnError)
          : `exited with ${code === null ? `signal ${signal}` : `code ${code}`}`)
      reject(
        new Error(
          `${file} ${args.join(' ')} failed: ${reason}${stderr.trim() ? `\n${stderr.trim()}` : ''}${stdout.trim() ? `\n${stdout.trim()}` : ''}`,
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
        const retained = chunk.subarray(0, remaining)
        if (target === 'stdout') {
          stdoutChunks.push(Buffer.from(retained))
          stdout += retained.toString('utf8')
        } else stderr += retained.toString('utf8')
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
    if (input !== undefined) child.stdin.end(input)
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
    'THIRD_PARTY_NOTICES.md',
    'package.json',
    ...distFiles,
  ])
  const allowedDistSuffixes = ['.js', '.d.ts']
  const allowedSchemaJson =
    /^dist\/plugins\/mcpb-schemas\/mcpb-manifest-v0\.[1-4]\.schema\.json$/u
  for (const path of distFiles) {
    if (
      (!allowedDistSuffixes.some((suffix) => path.endsWith(suffix)) &&
        !allowedSchemaJson.test(path)) ||
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

function permissionPath(path) {
  return path.startsWith('/') ? `/${path}` : path
}

function resultFrom(output) {
  const result = parseJsonLines(output).findLast(
    (entry) => entry?.type === 'result',
  )
  if (!result) throw new Error(`Installed CLI returned no result: ${output}`)
  return result
}

function assertZeroCostJson(entry, output) {
  if (
    entry?.type !== 'result' ||
    entry?.subtype !== 'success' ||
    entry?.is_error !== false ||
    entry?.num_turns !== 0 ||
    entry?.duration_api_ms !== 0 ||
    entry?.total_cost_usd !== 0 ||
    entry?.stop_reason !== null ||
    entry?.result !== ZERO_COST_SUMMARY ||
    entry?.usage?.input_tokens !== 0 ||
    entry?.usage?.output_tokens !== 0 ||
    !entry?.modelUsage ||
    Object.keys(entry.modelUsage).length !== 0 ||
    !Array.isArray(entry?.permission_denials) ||
    entry.permission_denials.length !== 0 ||
    typeof entry?.session_id !== 'string' ||
    entry.session_id.length === 0
  ) {
    throw new Error(`Installed /cost JSON zero-turn contract failed: ${output}`)
  }
}

function assertZeroCostStream(records, output) {
  if (records.length !== 3) {
    throw new Error(
      `Installed /cost stream-json produced ${records.length} records: ${output}`,
    )
  }
  const [init, assistant, result] = records
  if (
    init?.type !== 'system' ||
    init?.subtype !== 'init' ||
    assistant?.type !== 'assistant' ||
    result?.type !== 'result'
  ) {
    throw new Error(
      `Installed /cost stream-json record order mismatch: ${output}`,
    )
  }
  if (
    assistant?.message?.role !== 'assistant' ||
    assistant?.message?.model !== '<synthetic>' ||
    !Array.isArray(assistant?.message?.content) ||
    assistant.message.content.length !== 1 ||
    assistant.message.content[0]?.type !== 'text' ||
    assistant.message.content[0]?.text !== ZERO_COST_SUMMARY ||
    assistant?.message?.stop_reason !== 'stop_sequence' ||
    assistant?.message?.stop_sequence !== '' ||
    assistant?.message?.usage?.input_tokens !== 0 ||
    assistant?.message?.usage?.output_tokens !== 0 ||
    assistant?.parent_tool_use_id !== null ||
    typeof assistant?.session_id !== 'string' ||
    assistant.session_id.length === 0
  ) {
    throw new Error(
      `Installed /cost stream-json assistant contract failed: ${output}`,
    )
  }
  if (
    result?.subtype !== 'success' ||
    result?.is_error !== false ||
    result?.num_turns !== 0 ||
    result?.duration_api_ms !== 0 ||
    result?.total_cost_usd !== 0 ||
    result?.stop_reason !== null ||
    result?.result !== ZERO_COST_SUMMARY ||
    result?.usage?.input_tokens !== 0 ||
    result?.usage?.output_tokens !== 0 ||
    !result?.modelUsage ||
    Object.keys(result.modelUsage).length !== 0 ||
    result?.session_id !== assistant.session_id
  ) {
    throw new Error(
      `Installed /cost stream-json result contract failed: ${output}`,
    )
  }
}

async function snapshotTree(root) {
  const entries = []
  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        entries.push(`${relative}/`)
        await visit(join(directory, entry.name), relative)
      } else if (entry.isFile()) {
        entries.push(relative)
      } else {
        throw new Error(`Unsupported cost probe tree entry: ${relative}`)
      }
    }
  }
  await visit(root, '')
  return entries.sort()
}

function forkFrom(output) {
  const fork = parseJsonLines(output).findLast(
    (entry) => entry?.type === 'forked',
  )
  if (!fork) throw new Error(`Installed CLI returned no fork: ${output}`)
  return fork
}

function assertNativeFork(
  sourceText,
  forkText,
  sourceSessionId,
  forkSessionId,
) {
  const sourceLines = sourceText.trimEnd().split('\n')
  const forkLines = forkText.trimEnd().split('\n')
  const source = sourceLines.map((line) => JSON.parse(line))
  const actual = forkLines.map((line) => JSON.parse(line))
  const titles = []
  const modes = []
  const permissionModes = []
  const history = []
  let lastPrompt
  const isTransient = (entry) =>
    entry.type === 'file-history-delta' ||
    entry.type === 'file-history-snapshot' ||
    entry.type === 'queue-operation'
  for (const [index, entry] of source.entries()) {
    if (isTransient(entry) || entry.isSidechain === true) continue
    const line = sourceLines[index]
    if (!line) {
      throw new Error('Installed CLI source has invalid native sessionId')
    }
    const sourceProperty = `"sessionId":${JSON.stringify(sourceSessionId)}`
    const propertyIndex = line.indexOf(sourceProperty)
    if (
      propertyIndex < 0 ||
      line.indexOf(sourceProperty, propertyIndex + sourceProperty.length) >= 0
    ) {
      throw new Error('Installed CLI source has ambiguous native sessionId')
    }
    const copied = `${line.slice(0, propertyIndex)}"sessionId":${JSON.stringify(forkSessionId)}${line.slice(propertyIndex + sourceProperty.length)}`
    if (entry.type === 'ai-title') titles.push(copied)
    else if (entry.type === 'mode') modes.push(copied)
    else if (entry.type === 'permission-mode') permissionModes.push(copied)
    else if (entry.type === 'last-prompt') lastPrompt = copied
    else history.push(copied)
  }
  const expected = [
    ...titles.slice(-1),
    ...modes.slice(-1),
    ...permissionModes.slice(-1),
    ...history,
    ...(lastPrompt ? [lastPrompt] : []),
  ]
  if (
    source.some(
      (entry) =>
        !isTransient(entry) &&
        entry.isSidechain !== true &&
        entry.sessionId !== sourceSessionId,
    ) ||
    actual.some((entry) => entry.sessionId !== forkSessionId) ||
    JSON.stringify(forkLines) !== JSON.stringify(expected)
  ) {
    throw new Error('Installed CLI fork did not preserve native history')
  }
  for (const marker of [
    'release_read',
    'release_permission',
    'release_memory_read',
    'release_memory_write',
    'RELEASE_TOOL_MARKER',
    'RELEASE_PERMISSION_MARKER',
    'RELEASE_MEMORY_DETAIL_MARKER',
    'RELEASE_MEMORY_WRITE_MARKER',
  ]) {
    if (!forkText.includes(marker)) {
      throw new Error(`Installed CLI fork omitted ${marker}`)
    }
  }
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

function assertProviderConversation(messages, stage, memoryDirectory) {
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
  cursor = assertToolExchange(messages, cursor, {
    id: 'release_memory_read',
    name: 'Read',
    input: { file_path: join(memoryDirectory, 'details.md') },
    marker: 'RELEASE_MEMORY_DETAIL_MARKER',
  })
  if (stage === 'memory-read') {
    assertConversationEnd(messages, cursor, stage)
    return
  }
  cursor = assertToolExchange(messages, cursor, {
    id: 'release_memory_write',
    name: 'Write',
    input: {
      file_path: join(memoryDirectory, 'praxis-note.md'),
      content: 'RELEASE_MEMORY_WRITE_MARKER\n',
    },
    marker: 'Wrote',
  })
  if (stage === 'memory-write') {
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

function hasToolSchema(tools, name, property, required = true) {
  const tool = tools.find(
    (candidate) =>
      candidate?.type === 'function' && candidate?.function?.name === name,
  )
  const parameters = tool?.function?.parameters
  return (
    typeof tool?.function?.description === 'string' &&
    parameters?.type === 'object' &&
    parameters?.properties?.[property]?.type === 'string' &&
    (!required ||
      (Array.isArray(parameters?.required) &&
        parameters.required.includes(property)))
  )
}

function hasAnthropicToolSchema(tools, name, property, required = true) {
  const tool = tools.find((candidate) => candidate?.name === name)
  const inputSchema = tool?.input_schema
  return (
    typeof tool?.description === 'string' &&
    inputSchema?.type === 'object' &&
    inputSchema?.properties?.[property]?.type === 'string' &&
    (!required ||
      (Array.isArray(inputSchema?.required) &&
        inputSchema.required.includes(property)))
  )
}

function normalizeAnthropicSystem(system) {
  if (typeof system === 'string') return system
  if (
    Array.isArray(system) &&
    system.every(
      (block) => block?.type === 'text' && typeof block.text === 'string',
    )
  ) {
    return system.map((block) => block.text).join('')
  }
  throw new Error('Installed CLI sent invalid Anthropic system blocks')
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

async function startProviderProbe(provider, memoryDirectory) {
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
        const systemContext =
          provider === 'anthropic'
            ? normalizeAnthropicSystem(body.system)
            : messages
                .filter((message) => message?.role === 'system')
                .map((message) => message.content)
                .join('\n')
        if (
          typeof systemContext !== 'string' ||
          !systemContext.includes('RELEASE_MEMORY_LINK_MARKER') ||
          systemContext.includes('RELEASE_MEMORY_OVERFLOW_SENTINEL')
        ) {
          throw new Error(
            'Installed CLI returned invalid 200-line memory index context',
          )
        }
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
              hasAnthropicToolSchema(body.tools, 'Write', 'content') &&
              hasAnthropicToolSchema(body.tools, 'Bash', 'command')
            : Array.isArray(body.tools) &&
              hasToolSchema(body.tools, 'Read', 'file_path') &&
              hasToolSchema(body.tools, 'Write', 'content') &&
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
        assertProviderConversation(messages, 'read', memoryDirectory)
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
        assertProviderConversation(messages, 'tools', memoryDirectory)
        const input = { file_path: join(memoryDirectory, 'details.md') }
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
                id: 'release_memory_read',
                name: 'Read',
                input: {},
              },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify(input),
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
                        id: 'release_memory_read',
                        type: 'function',
                        function: {
                          name: 'Read',
                          arguments: JSON.stringify(input),
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
      if (requests.length === 4) {
        assertProviderConversation(messages, 'memory-read', memoryDirectory)
        const input = {
          file_path: join(memoryDirectory, 'praxis-note.md'),
          content: 'RELEASE_MEMORY_WRITE_MARKER\n',
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
                id: 'release_memory_write',
                name: 'Write',
                input: {},
              },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify(input),
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
                        id: 'release_memory_write',
                        type: 'function',
                        function: {
                          name: 'Write',
                          arguments: JSON.stringify(input),
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
      if (requests.length === 5) {
        assertProviderConversation(messages, 'memory-write', memoryDirectory)
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
              choices: [
                {
                  delta: { content: 'installed tool loop response' },
                  finish_reason: 'stop',
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
      if (requests.length === 6) {
        assertProviderConversation(messages, 'resume', memoryDirectory)
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
              choices: [
                {
                  delta: { content: 'installed resume response' },
                  finish_reason: 'stop',
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
      if (requests.length !== 6) {
        throw new Error(`Provider probe received ${requests.length} requests`)
      }
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

async function startProtocolProviderProbe(provider) {
  const requests = []
  let failure
  const responses = ['installed protocol first', 'installed protocol second']
  const server = createServer(async (request, response) => {
    try {
      const expectedPath =
        provider === 'anthropic' ? '/v1/messages' : '/v1/chat/completions'
      if (request.method !== 'POST' || request.url !== expectedPath) {
        response.writeHead(404).end()
        return
      }
      const body = await readProviderRequest(request)
      if (
        body?.model !== 'release-probe-model' ||
        body?.stream !== true ||
        !Array.isArray(body?.messages)
      ) {
        throw new Error(
          'Installed protocol CLI sent an invalid provider request',
        )
      }
      requests.push(body)
      const conversation = JSON.stringify(body.messages)
      if (!conversation.includes(`protocol prompt ${requests.length}`)) {
        throw new Error(
          `Installed protocol CLI omitted prompt ${requests.length}`,
        )
      }
      if (
        requests.length === 2 &&
        !conversation.includes('installed protocol first')
      ) {
        throw new Error('Installed protocol CLI did not resume first response')
      }
      const text = responses[requests.length - 1]
      if (!text || requests.length > responses.length) {
        throw new Error(
          `Unexpected protocol provider request ${requests.length}`,
        )
      }
      if (provider === 'anthropic') {
        sendAnthropicEvents(response, [
          {
            type: 'message_start',
            message: { usage: { input_tokens: 3 } },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 2 },
          },
          { type: 'message_stop' },
        ])
      } else {
        sendOpenAIEvents(response, [
          {
            choices: [{ delta: { content: text }, finish_reason: 'stop' }],
          },
          {
            choices: [],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          },
        ])
      }
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
    throw new Error('Protocol provider probe has no TCP address')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    assertComplete() {
      if (failure) throw failure
      if (requests.length !== 2) {
        throw new Error(
          `Protocol provider probe received ${requests.length} requests`,
        )
      }
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

async function startSubagentProviderProbe(provider) {
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
      const body = await readProviderRequest(request)
      requests.push(body)
      const messages =
        provider === 'anthropic'
          ? normalizeAnthropicMessages(body.messages)
          : body.messages
      const hasAgentSchema =
        provider === 'anthropic'
          ? Array.isArray(body.tools) &&
            hasAnthropicToolSchema(body.tools, 'Agent', 'prompt') &&
            hasAnthropicToolSchema(body.tools, 'Agent', 'subagent_type', false)
          : Array.isArray(body.tools) &&
            hasToolSchema(body.tools, 'Agent', 'prompt') &&
            hasToolSchema(body.tools, 'Agent', 'subagent_type', false)
      if (requests.length === 2 && hasAgentSchema) {
        throw new Error('Installed CLI exposed Agent tool to a subagent')
      }
      if (requests.length !== 2 && !hasAgentSchema) {
        const agentSchema =
          provider === 'anthropic'
            ? body.tools?.find((tool) => tool.name === 'Agent')
            : body.tools?.find((tool) => tool.function?.name === 'Agent')
        throw new Error(
          `Installed CLI omitted Agent tool schema: ${JSON.stringify(
            agentSchema ??
              body.tools?.map(
                (tool) => tool.name ?? tool.function?.name ?? '<unknown>',
              ),
          )}`,
        )
      }
      if (requests.length === 1) {
        if (
          messages.at(-1)?.role !== 'user' ||
          messages.at(-1)?.content !== 'delegate release subagent'
        ) {
          throw new Error('Installed CLI omitted subagent main prompt')
        }
        const input = {
          description: 'Return release marker',
          prompt: 'Return RELEASE_SUBAGENT_MARKER',
          subagent_type: 'general-purpose',
          run_in_background: false,
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
                id: 'release_agent',
                name: 'Agent',
                input: {},
              },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify(input),
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
                        id: 'release_agent',
                        type: 'function',
                        function: {
                          name: 'Agent',
                          arguments: JSON.stringify(input),
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
        const system =
          provider === 'anthropic'
            ? normalizeAnthropicSystem(body.system)
            : messages
                .filter((message) => message?.role === 'system')
                .map((message) => message.content)
                .join('\n')
        if (
          typeof system !== 'string' ||
          !system.includes('general-purpose subagent') ||
          messages.at(-1)?.content !== 'Return RELEASE_SUBAGENT_MARKER'
        ) {
          throw new Error('Installed CLI sent invalid subagent context')
        }
        if (provider === 'anthropic') {
          sendAnthropicEvents(response, [
            {
              type: 'message_start',
              message: { usage: { input_tokens: 7 } },
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
                text: 'RELEASE_SUBAGENT_MARKER',
              },
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 3 },
            },
            { type: 'message_stop' },
          ])
        } else {
          sendOpenAIEvents(response, [
            {
              choices: [
                {
                  delta: { content: 'RELEASE_SUBAGENT_MARKER' },
                  finish_reason: 'stop',
                },
              ],
            },
            {
              choices: [],
              usage: { prompt_tokens: 7, completion_tokens: 3 },
            },
          ])
        }
        return
      }
      if (requests.length === 3) {
        const serialized = JSON.stringify(messages)
        if (
          !serialized.includes('release_agent') ||
          !serialized.includes('RELEASE_SUBAGENT_MARKER')
        ) {
          throw new Error('Installed CLI omitted Agent result continuation')
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
              content_block: { type: 'text', text: '' },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'text_delta',
                text: 'installed subagent response',
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
              choices: [
                {
                  delta: { content: 'installed subagent response' },
                  finish_reason: 'stop',
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
      throw new Error(`Unexpected subagent provider request ${requests.length}`)
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
    throw new Error('Subagent provider probe has no TCP address')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    assertComplete() {
      if (failure) throw failure
      if (requests.length !== 3) {
        throw new Error(
          `Subagent provider probe received ${requests.length} requests`,
        )
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
  const packagedDistFiles = distFiles
    .filter((path) => !path.endsWith('.map'))
    .map((path) => `dist/${path}`)

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
  const packagedSourceMaps = packed.files.filter((file) =>
    file.path.endsWith('.map'),
  )
  if (packagedSourceMaps.length > 0) {
    throw new Error(
      `Release package unexpectedly contains source maps: ${packagedSourceMaps.map((file) => file.path).join(', ')}`,
    )
  }
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
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
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
  await run(
    'npm',
    ['audit', '--omit', 'dev', '--audit-level', 'high', '--json'],
    { cwd: installRoot },
  )

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
  const costConfigRoot = join(probeRoot, 'cost-config')
  const costWorkDirectory = join(probeRoot, 'cost-work')
  await mkdir(costConfigRoot, { recursive: true })
  await mkdir(costWorkDirectory, { recursive: true })
  const costEnvironment = {
    ...process.env,
    CLAUDE_CONFIG_DIR: costConfigRoot,
    PRAXIS_DATA_PLANE: 'native',
    PRAXIS_HOME: costConfigRoot,
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
  }
  for (const name of [
    'PRAXIS_PROVIDER',
    'PRAXIS_API_KEY',
    'PRAXIS_MODEL',
    'PRAXIS_BASE_URL',
  ]) {
    delete costEnvironment[name]
  }
  const costConfigBefore = await snapshotTree(costConfigRoot)
  const costWorkBefore = await snapshotTree(costWorkDirectory)

  const installedCostText = await run(praxis, ['-p', '/cost'], {
    cwd: costWorkDirectory,
    env: costEnvironment,
  })
  if (
    installedCostText.stdout !== `${ZERO_COST_SUMMARY}\n` ||
    installedCostText.stderr !== ''
  ) {
    throw new Error(
      `Installed provider-free /cost text mismatch: stdout ${JSON.stringify(installedCostText.stdout)} stderr ${JSON.stringify(installedCostText.stderr)}`,
    )
  }

  const installedCostJson = await run(
    praxis,
    ['-p', '--output-format', 'json', '/cost'],
    { cwd: costWorkDirectory, env: costEnvironment },
  )
  let installedCostJsonResult
  try {
    installedCostJsonResult = JSON.parse(installedCostJson.stdout)
  } catch (error) {
    throw new Error(
      `Installed /cost JSON output is not valid JSON: ${installedCostJson.stdout}`,
      { cause: error },
    )
  }
  assertZeroCostJson(installedCostJsonResult, installedCostJson.stdout)

  const installedCostStream = await run(
    praxis,
    [
      'run',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
    ],
    {
      cwd: costWorkDirectory,
      env: costEnvironment,
      input: `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '/cost' },
      })}\n`,
    },
  )
  let installedCostStreamRecords
  try {
    installedCostStreamRecords = parseJsonLines(installedCostStream.stdout)
  } catch (error) {
    throw new Error(
      `Installed /cost stream-json output is not valid JSON lines: ${installedCostStream.stdout}`,
      { cause: error },
    )
  }
  assertZeroCostStream(installedCostStreamRecords, installedCostStream.stdout)

  const costConfigAfter = await snapshotTree(costConfigRoot)
  const costWorkAfter = await snapshotTree(costWorkDirectory)
  if (
    JSON.stringify(costConfigAfter) !== JSON.stringify(costConfigBefore) ||
    JSON.stringify(costWorkAfter) !== JSON.stringify(costWorkBefore)
  ) {
    throw new Error(
      `Installed provider-free /cost side-effect mismatch: config ${JSON.stringify(costConfigAfter)} work ${JSON.stringify(costWorkAfter)}`,
    )
  }

  const sessions = await run(praxis, ['sessions', '--json'], {
    cwd: workDirectory,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configRoot,
      PRAXIS_DATA_PLANE: 'native',
      PRAXIS_HOME: configRoot,
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

  const sharedResourcesModule = await import(
    pathToFileURL(
      join(
        installedPackage,
        'dist',
        'compatibility',
        'claude',
        'shared-resources.js',
      ),
    ).href
  )
  const pathsModule = await import(
    pathToFileURL(
      join(installedPackage, 'dist', 'compatibility', 'claude', 'paths.js'),
    ).href
  )
  const schemaModule = await import(
    pathToFileURL(
      join(installedPackage, 'dist', 'compatibility', 'claude', 'schema.js'),
    ).href
  )
  const memoryDirectory =
    await sharedResourcesModule.resolveClaudeProjectMemoryDirectory({
      configRoot,
      cwd: workDirectory,
    })
  await mkdir(memoryDirectory, { recursive: true })
  const memoryIndex = [
    '# Shared memory',
    '- [release detail](details.md) RELEASE_MEMORY_LINK_MARKER',
    ...Array.from({ length: 198 }, (_, index) => `memory filler ${index + 3}`),
    'RELEASE_MEMORY_OVERFLOW_SENTINEL',
  ].join('\n')
  await Promise.all([
    writeFile(join(memoryDirectory, 'MEMORY.md'), memoryIndex),
    writeFile(
      join(memoryDirectory, 'details.md'),
      'RELEASE_MEMORY_DETAIL_MARKER\n',
    ),
  ])

  await writeFile(
    join(configRoot, 'settings.json'),
    `${JSON.stringify({
      permissions: {
        allow: [
          "Bash(sed -n '1p' release-permission.txt)",
          `Write(${permissionPath(join(memoryDirectory, 'praxis-note.md'))})`,
        ],
      },
    })}\n`,
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
    providerProbe = await startProviderProbe(provider, memoryDirectory)
    const providerEnvironment = {
      ...process.env,
      CLAUDE_CONFIG_DIR: configRoot,
      PRAXIS_DATA_PLANE: 'claude',
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
      runResult.usage?.inputTokens !== 40 ||
      runResult.usage?.outputTokens !== 20
    ) {
      throw new Error(
        `Installed ${provider} CLI returned invalid run usage ${JSON.stringify(runResult.usage)}`,
      )
    }
    if (
      (await readFile(join(memoryDirectory, 'praxis-note.md'), 'utf8')) !==
      'RELEASE_MEMORY_WRITE_MARKER\n'
    ) {
      throw new Error(`Installed ${provider} CLI did not write shared memory`)
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
    const installedFork = await run(
      praxis,
      ['fork', '--json', runResult.sessionId],
      { cwd: workDirectory, env: providerEnvironment },
    )
    const forkResult = forkFrom(installedFork.stdout)
    if (
      typeof forkResult.sessionId !== 'string' ||
      forkResult.sessionId === runResult.sessionId ||
      forkResult.parentSessionId !== runResult.sessionId
    ) {
      throw new Error(`Installed ${provider} CLI returned an invalid fork`)
    }
    providerProbe.assertComplete()
    const canonicalWorkDirectory = await realpath(workDirectory)
    const sourcePath = pathsModule.resolveClaudePaths({
      configDir: configRoot,
      cwd: canonicalWorkDirectory,
      sessionId: runResult.sessionId,
    }).sessionFile
    const forkPath = pathsModule.resolveClaudePaths({
      configDir: configRoot,
      cwd: canonicalWorkDirectory,
      sessionId: forkResult.sessionId,
    }).sessionFile
    const inspected = await run(
      praxis,
      ['inspect', '--json', runResult.sessionId],
      { cwd: workDirectory, env: providerEnvironment },
    )
    const inspection = JSON.parse(inspected.stdout)
    if (
      inspection.type !== 'session' ||
      inspection.session?.sessionId !== runResult.sessionId ||
      inspection.session?.status !== 'ready' ||
      inspection.session?.writeMode !== 'read-write' ||
      inspection.session?.entryCount < 1
    ) {
      throw new Error(
        `Installed ${provider} CLI inspect failed: ${inspected.stdout}`,
      )
    }
    const exported = await run(praxis, ['export', runResult.sessionId], {
      cwd: workDirectory,
      env: providerEnvironment,
    })
    if (!exported.stdoutBytes.equals(await readFile(sourcePath))) {
      throw new Error(`Installed ${provider} CLI export changed transcript`)
    }
    providerProbe.assertComplete()
    assertNativeFork(
      await readFile(sourcePath, 'utf8'),
      await readFile(forkPath, 'utf8'),
      runResult.sessionId,
      forkResult.sessionId,
    )
    await providerProbe.close()
    providerProbe = undefined

    providerProbe = await startProtocolProviderProbe(provider)
    const protocolSessionId =
      provider === 'openai'
        ? '44444444-4444-4444-8444-444444444444'
        : '55555555-5555-4555-8555-555555555555'
    const protocolEnvironment = {
      ...process.env,
      CLAUDE_CONFIG_DIR: configRoot,
      PRAXIS_DATA_PLANE: 'claude',
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      PRAXIS_PROVIDER: provider,
      PRAXIS_API_KEY: 'release-probe-key',
      PRAXIS_MODEL: 'release-probe-model',
      PRAXIS_BASE_URL: providerProbe.baseUrl,
      ...(provider === 'anthropic' ? { PRAXIS_MAX_OUTPUT_TOKENS: '1024' } : {}),
    }
    const protocolInput = [1, 2]
      .map((turn) =>
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: `protocol prompt ${turn}` },
        }),
      )
      .join('\n')
    const installedProtocol = await run(
      praxis,
      [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--replay-user-messages',
        '--session-id',
        protocolSessionId,
      ],
      {
        cwd: workDirectory,
        env: protocolEnvironment,
        input: `${protocolInput}\n`,
      },
    )
    const protocolRecords = parseJsonLines(installedProtocol.stdout)
    const protocolInits = protocolRecords.filter(
      (record) => record.type === 'system' && record.subtype === 'init',
    )
    const protocolResults = protocolRecords.filter(
      (record) => record.type === 'result',
    )
    const replayedMessages = protocolRecords.filter(
      (record) =>
        record.type === 'user' && typeof record.message?.content === 'string',
    )
    if (
      protocolInits.length !== 2 ||
      protocolResults.length !== 2 ||
      replayedMessages.length !== 2 ||
      protocolRecords.some((record) =>
        ['state', 'text-delta', 'usage'].includes(record.type),
      ) ||
      protocolRecords.some(
        (record) =>
          record.session_id !== undefined &&
          record.session_id !== protocolSessionId,
      ) ||
      protocolResults[0]?.result !== 'installed protocol first' ||
      protocolResults[1]?.result !== 'installed protocol second' ||
      protocolResults.some(
        (record) =>
          record.subtype !== 'success' ||
          record.is_error !== false ||
          record.num_turns !== 1,
      )
    ) {
      throw new Error(
        `Installed ${provider} CLI stream protocol mismatch: ${installedProtocol.stdout}`,
      )
    }
    providerProbe.assertComplete()
    await providerProbe.close()
    providerProbe = undefined

    providerProbe = await startSubagentProviderProbe(provider)
    const subagentEnvironment = {
      ...process.env,
      CLAUDE_CONFIG_DIR: configRoot,
      PRAXIS_DATA_PLANE: 'claude',
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      PRAXIS_PROVIDER: provider,
      PRAXIS_API_KEY: 'release-probe-key',
      PRAXIS_MODEL: 'release-probe-model',
      PRAXIS_BASE_URL: providerProbe.baseUrl,
      ...(provider === 'anthropic' ? { PRAXIS_MAX_OUTPUT_TOKENS: '1024' } : {}),
    }
    const installedSubagent = resultFrom(
      (
        await run(praxis, ['run', '--json', 'delegate release subagent'], {
          cwd: workDirectory,
          env: subagentEnvironment,
        })
      ).stdout,
    )
    if (
      installedSubagent.text !== 'installed subagent response' ||
      installedSubagent.usage?.inputTokens !== 23 ||
      installedSubagent.usage?.outputTokens !== 11
    ) {
      throw new Error(
        `Installed ${provider} CLI returned invalid subagent result`,
      )
    }
    const subagentPaths = pathsModule.resolveClaudePaths({
      configDir: configRoot,
      cwd: await realpath(workDirectory),
      sessionId: installedSubagent.sessionId,
    })
    const mainSource = await readFile(subagentPaths.sessionFile, 'utf8')
    const subagentDirectory = join(
      subagentPaths.projectRoot,
      installedSubagent.sessionId,
      'subagents',
    )
    const subagentFiles = await readdir(subagentDirectory)
    const transcriptName = subagentFiles.find((name) => name.endsWith('.jsonl'))
    const metadataName = subagentFiles.find((name) =>
      name.endsWith('.meta.json'),
    )
    if (!transcriptName || !metadataName) {
      throw new Error(`Installed ${provider} CLI omitted sidechain files`)
    }
    const sidechainSource = await readFile(
      join(subagentDirectory, transcriptName),
      'utf8',
    )
    const metadata = JSON.parse(
      await readFile(join(subagentDirectory, metadataName), 'utf8'),
    )
    if (
      !mainSource.includes('"status":"completed"') ||
      !mainSource.includes('RELEASE_SUBAGENT_MARKER') ||
      !sidechainSource.includes('"isSidechain":true') ||
      !sidechainSource.includes('RELEASE_SUBAGENT_MARKER') ||
      metadata.agentType !== 'general-purpose' ||
      metadata.toolUseId !== 'release_agent' ||
      metadata.spawnDepth !== 1
    ) {
      throw new Error(
        `Installed ${provider} CLI wrote invalid native subagent state`,
      )
    }
    providerProbe.assertComplete()
    await providerProbe.close()
    providerProbe = undefined

    providerProbe = await startSubagentProviderProbe(provider)
    subagentEnvironment.PRAXIS_BASE_URL = providerProbe.baseUrl
    const installedEphemeralSubagent = resultFrom(
      (
        await run(
          praxis,
          [
            'run',
            '--json',
            '--no-session-persistence',
            'delegate release subagent',
          ],
          { cwd: workDirectory, env: subagentEnvironment },
        )
      ).stdout,
    )
    if (
      installedEphemeralSubagent.text !== 'installed subagent response' ||
      installedEphemeralSubagent.usage?.inputTokens !== 23 ||
      installedEphemeralSubagent.usage?.outputTokens !== 11
    ) {
      throw new Error(
        `Installed ${provider} CLI returned invalid ephemeral subagent result`,
      )
    }
    const ephemeralSubagentPaths = pathsModule.resolveClaudePaths({
      configDir: configRoot,
      cwd: await realpath(workDirectory),
      sessionId: installedEphemeralSubagent.sessionId,
    })
    await assertMissing(
      ephemeralSubagentPaths.sessionFile,
      `Installed ${provider} ephemeral main transcript`,
    )
    await assertMissing(
      join(
        ephemeralSubagentPaths.projectRoot,
        installedEphemeralSubagent.sessionId,
      ),
      `Installed ${provider} ephemeral session directory`,
    )
    providerProbe.assertComplete()
    await providerProbe.close()
    providerProbe = undefined
  }

  const sessionModule = await import(
    pathToFileURL(
      join(installedPackage, 'dist', 'application', 'session-service.js'),
    ).href
  )
  const versionMatrix = [
    ['2.1.208', 'read-write'],
    ['2.1.207', 'read-write'],
    ['2.1.209', 'read-write'],
    ['3.0.0', 'read-write'],
    ['latest', 'read-only'],
  ]
  const matrixWorkDirectory = await realpath(workDirectory)
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
      cwd: matrixWorkDirectory,
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
      const cliSessionId = matrixSessions[0].sessionId
      const cliSessionFile = pathsModule.resolveClaudePaths({
        configDir: matrixConfigRoot,
        cwd: matrixWorkDirectory,
        sessionId: cliSessionId,
      }).sessionFile
      const cliSource = await readFile(cliSessionFile)
      const corruptSessionId = '88888888-8888-4888-8888-888888888888'
      const corruptSessionFile = pathsModule.resolveClaudePaths({
        configDir: matrixConfigRoot,
        cwd: matrixWorkDirectory,
        sessionId: corruptSessionId,
      }).sessionFile
      const corruptSource = Buffer.concat([
        cliSource,
        Buffer.from([0xff, 0x0a]),
      ])
      await writeFile(corruptSessionFile, corruptSource)
      await writeFile(
        join(fakeBin, 'claude'),
        `#!/bin/sh\nprintf '${claudeVersion} (Claude Code)\\n'\n`,
        { mode: 0o755 },
      )
      const cliEnvironment = {
        ...process.env,
        CLAUDE_CONFIG_DIR: matrixConfigRoot,
        PRAXIS_DATA_PLANE: 'claude',
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      }
      for (const name of [
        'PRAXIS_PROVIDER',
        'PRAXIS_API_KEY',
        'PRAXIS_MODEL',
        'PRAXIS_BASE_URL',
        'PRAXIS_MAX_OUTPUT_TOKENS',
        'PRAXIS_ANTHROPIC_VERSION',
      ]) {
        delete cliEnvironment[name]
      }
      const cliSessions = JSON.parse(
        (
          await run(praxis, ['sessions', '--json'], {
            cwd: workDirectory,
            env: cliEnvironment,
          })
        ).stdout,
      )
      const cliReady = cliSessions.sessions?.find(
        (summary) => summary.sessionId === cliSessionId,
      )
      const cliCorrupt = cliSessions.sessions?.find(
        (summary) => summary.sessionId === corruptSessionId,
      )
      const cliInspection = JSON.parse(
        (
          await run(praxis, ['inspect', '--json', cliSessionId], {
            cwd: workDirectory,
            env: cliEnvironment,
          })
        ).stdout,
      )
      const cliCorruptInspection = JSON.parse(
        (
          await run(praxis, ['inspect', '--json', corruptSessionId], {
            cwd: workDirectory,
            env: cliEnvironment,
          })
        ).stdout,
      )
      const cliReadWriteExport = await run(praxis, ['export', cliSessionId], {
        cwd: workDirectory,
        env: cliEnvironment,
      })
      const cliCorruptExport = await run(praxis, ['export', corruptSessionId], {
        cwd: workDirectory,
        env: cliEnvironment,
      })
      if (
        cliReady?.status !== 'ready' ||
        cliCorrupt?.status !== 'corrupt' ||
        cliInspection.session?.writeMode !== 'read-write' ||
        cliCorruptInspection.session?.status !== 'corrupt' ||
        !cliReadWriteExport.stdoutBytes.equals(cliSource) ||
        !cliCorruptExport.stdoutBytes.equals(corruptSource)
      ) {
        throw new Error(
          `Installed Claude ${claudeVersion} ordinary CLI schema-independence proof failed`,
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
    const readOnlySessionId = '99999999-9999-4999-8999-999999999999'
    const readOnlySessionFile = pathsModule.resolveClaudePaths({
      configDir: matrixConfigRoot,
      cwd: matrixWorkDirectory,
      sessionId: readOnlySessionId,
    }).sessionFile
    const readOnlySource = `${JSON.stringify({
      type: 'future-native-entry',
      sessionId: readOnlySessionId,
      version: claudeVersion,
      preserve: true,
    })}\n`
    await mkdir(dirname(readOnlySessionFile), { recursive: true })
    await writeFile(readOnlySessionFile, readOnlySource)
    const corruptSessionId = '88888888-8888-4888-8888-888888888888'
    const corruptSessionFile = pathsModule.resolveClaudePaths({
      configDir: matrixConfigRoot,
      cwd: matrixWorkDirectory,
      sessionId: corruptSessionId,
    }).sessionFile
    const corruptSource = Buffer.concat([
      Buffer.from(readOnlySource),
      Buffer.from([0xff, 0x0a]),
    ])
    await writeFile(corruptSessionFile, corruptSource)
    const readOnlySummaries = await service.sessions()
    const readOnlySummary = readOnlySummaries.find(
      (summary) => summary.sessionId === readOnlySessionId,
    )
    const readOnlyInspection = await service.inspect(readOnlySessionId)
    if (
      readOnlySummary?.status !== 'read-only' ||
      readOnlyInspection.status !== 'read-only' ||
      readOnlyInspection.writeMode !== 'read-only' ||
      !(await service.export(readOnlySessionId)).equals(
        Buffer.from(readOnlySource),
      )
    ) {
      throw new Error(
        `Claude ${claudeVersion} read-only inspection/export failed`,
      )
    }
    await expectRejected(() => service.run('must stay read-only'), 'read-only')
    await expectRejected(() => service.fork(readOnlySessionId), 'read-only')
    if (
      (await service.sessions()).length !== 2 ||
      (await readFile(readOnlySessionFile, 'utf8')) !== readOnlySource ||
      !(await readFile(corruptSessionFile)).equals(corruptSource)
    ) {
      throw new Error(
        `Claude ${claudeVersion} read-only matrix changed a session`,
      )
    }
  }

  console.log(
    `Praxis ${manifest.version} release package passed: ${packed.files.length} files, ${packed.size} compressed bytes, clean tarball install with zero high-risk production advisories, installed provider-free /cost text/JSON/stream-json gates with zero artifacts, installed OpenAI/Anthropic CLI provider/tool/resume/native-fork/subagent loops and two-turn stream protocol, and Claude 2.1.207/2.1.208/2.1.209/3.0.0 semver read/write matrix with installed ordinary CLI schema-independence proof and malformed-version fail-closed read-only check`,
  )
} finally {
  try {
    if (providerProbe) await providerProbe.close()
  } finally {
    await rm(probeRoot, { recursive: true })
  }
}
