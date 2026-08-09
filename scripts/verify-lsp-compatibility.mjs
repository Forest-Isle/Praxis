import { spawn } from 'node:child_process'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'

import { detectClaudeVersion } from './lib/claude-probe.mjs'

const root = await mkdtemp(join(tmpdir(), 'praxis-lsp-compat-'))
let cwd = join(root, 'project')
const plugin = join(root, 'plugin')
const serverPath = join(root, 'fixture-lsp.cjs')
const serverLog = join(root, 'lsp-events.jsonl')
const sourceFile = join(cwd, 'main.fixture')
const requests = []
const operations = [
  'goToDefinition',
  'findReferences',
  'hover',
  'documentSymbol',
  'workspaceSymbol',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
]
const roundTripMarker = 'LSP_ROUND_TRIP_READY'
const disabledMarker = 'LSP_DISABLED_READY'
const headlessMarker = 'LSP_HEADLESS_READY'
let failure

function assert(value, message) {
  if (!value) throw new Error(message)
}

function responseEvents(model, fixtureResponse) {
  const block = fixtureResponse.tool
    ? {
        start: {
          type: 'tool_use',
          id: fixtureResponse.tool.id,
          name: fixtureResponse.tool.name,
          input: {},
        },
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(fixtureResponse.tool.input),
        },
      }
    : {
        start: { type: 'text', text: '' },
        delta: { type: 'text_delta', text: fixtureResponse.text },
      }
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_lsp_${requests.length}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: block.start },
    { type: 'content_block_delta', index: 0, delta: block.delta },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: {
        stop_reason: fixtureResponse.tool ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]
}

const provider = createServer(async (request, response) => {
  try {
    if (request.method === 'HEAD') {
      response.writeHead(200).end()
      return
    }
    let source = ''
    request.setEncoding('utf8')
    for await (const chunk of request) source += chunk
    if (!source) {
      response.writeHead(404).end()
      return
    }
    const body = JSON.parse(source)
    requests.push(body)
    const messages = JSON.stringify(body.messages ?? [])
    let fixtureResponse
    if (messages.includes('LSP_TOOL_ROUND_TRIP')) {
      const toolResults = (body.messages ?? []).flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.filter((item) => item.type === 'tool_result')
          : [],
      )
      const operation = operations[toolResults.length]
      fixtureResponse = operation
        ? {
            tool: {
              id: `toolu_lsp_${requests.length}`,
              name: 'LSP',
              input: {
                operation,
                filePath: sourceFile,
                line: 1,
                character: 1,
                ...(operation === 'workspaceSymbol'
                  ? { query: 'fixture' }
                  : {}),
              },
            },
          }
        : { text: roundTripMarker }
    } else if (messages.includes('LSP_TOOL_DISABLED')) {
      fixtureResponse = { text: disabledMarker }
    } else fixtureResponse = { text: headlessMarker }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      responseEvents(body.model, fixtureResponse)
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(''),
    )
  } catch (error) {
    failure ??= error
    response.writeHead(500).end()
  }
})

function waitForExit(child, label, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${label} timed out: ${output.slice(-4000)}`))
    }, timeoutMs)
    const capture = (chunk) => {
      output += chunk.toString('utf8')
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0) resolve(output)
      else
        reject(
          new Error(
            `${label} failed${signal ? ` with ${signal}` : ` with exit ${code}`}: ${output.slice(-4000)}`,
          ),
        )
    })
  })
}

async function runTty(
  command,
  args,
  env,
  label,
  marker,
  exitWithCtrlC = false,
) {
  const driver = `
import os, select, subprocess, sys, time
marker = sys.argv[1].encode()
exit_mode = sys.argv[2]
master, slave = os.openpty()
process = subprocess.Popen(sys.argv[3:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
output = b''
sent = False
selected = False
exit_deadline = None
forced = False
while process.poll() is None:
    if exit_deadline and time.time() >= exit_deadline:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
        forced = True
        break
    ready, _, _ = select.select([master], [], [], 0.1)
    if not ready:
        continue
    try:
        chunk = os.read(master, 65536)
    except OSError:
        break
    if not chunk:
        break
    output += chunk
    sys.stdout.buffer.write(chunk)
    sys.stdout.buffer.flush()
    if not selected and b'Select session' in output:
        selected = True
        time.sleep(0.2)
        os.write(master, b'\\r')
    if not sent and marker in output:
        sent = True
        time.sleep(0.75)
        if exit_mode == 'ctrl-c':
            os.write(master, b'\\x03')
        else:
            os.write(master, b'/exit')
            time.sleep(0.1)
            os.write(master, b'\\r')
        exit_deadline = time.time() + 5
code = process.wait()
sys.exit(0 if sent and (forced or code in (0, 130)) else code)
`
  return waitForExit(
    spawn(
      'python3',
      [
        '-c',
        driver,
        marker,
        exitWithCtrlC ? 'ctrl-c' : 'slash',
        command,
        ...args,
      ],
      {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ),
    label,
  )
}

function runHeadless(command, args, env, label) {
  return waitForExit(
    spawn(command, [...args, '-p', 'LSP_HEADLESS_SURFACE'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
    label,
  )
}

function requestFor(marker, label) {
  const matches = requests.filter((request) =>
    JSON.stringify(request.messages ?? []).includes(marker),
  )
  assert(matches.length > 0, `Missing provider request for ${label}`)
  return matches.sort(
    (left, right) => (right.tools?.length ?? 0) - (left.tools?.length ?? 0),
  )[0]
}

function tool(request, name) {
  return (request.tools ?? []).find((candidate) => candidate.name === name)
}

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'description' && key !== '$schema')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalized(nested)]),
  )
}

function toolResultContents(request) {
  return (request.messages ?? []).flatMap((message) =>
    Array.isArray(message.content)
      ? message.content
          .filter((item) => item.type === 'tool_result')
          .map((item) => String(item.content))
      : [],
  )
}

function normalizedResult(content) {
  return content.replaceAll('/private/var/', '/var/')
}

async function seedClaudeConfig(configRoot) {
  await mkdir(configRoot, { recursive: true })
  await writeFile(
    join(configRoot, '.claude.json'),
    JSON.stringify({
      theme: 'dark',
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.208',
      projects: { [cwd]: { hasTrustDialogAccepted: true } },
    }),
  )
}

const fixtureServer = String.raw`
const fs = require('node:fs')
let buffer = Buffer.alloc(0)
function log(method) { fs.appendFileSync(process.env.LSP_EVENT_LOG, JSON.stringify({method}) + '\n') }
function send(value) {
  const body = Buffer.from(JSON.stringify(value))
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]))
}
function receive(message) {
  log(message.method || 'response')
  if (message.method === 'exit') process.exit(0)
  if (message.id === undefined) return
  if (message.method === 'initialize') return send({jsonrpc:'2.0',id:message.id,result:{capabilities:{documentSymbolProvider:true}}})
  if (message.method === 'shutdown') return send({jsonrpc:'2.0',id:message.id,result:null})
  const uri = message.params?.textDocument?.uri || 'file:///fixture/main.fixture'
  const range = {start:{line:0,character:0},end:{line:0,character:13}}
  const item = {name:'fixtureSymbol',kind:12,uri,range,selectionRange:range}
  const location = {uri,range}
  if (message.method === 'textDocument/definition' || message.method === 'textDocument/implementation') return send({jsonrpc:'2.0',id:message.id,result:location})
  if (message.method === 'textDocument/references') return send({jsonrpc:'2.0',id:message.id,result:[location]})
  if (message.method === 'textDocument/hover') return send({jsonrpc:'2.0',id:message.id,result:{contents:{kind:'markdown',value:'**fixture hover**'},range}})
  if (message.method === 'textDocument/documentSymbol') return send({jsonrpc:'2.0',id:message.id,result:[item]})
  if (message.method === 'workspace/symbol') return send({jsonrpc:'2.0',id:message.id,result:[{name:'fixtureSymbol',kind:12,location}]})
  if (message.method === 'textDocument/prepareCallHierarchy') return send({jsonrpc:'2.0',id:message.id,result:[item]})
  if (message.method === 'callHierarchy/incomingCalls') return send({jsonrpc:'2.0',id:message.id,result:[{from:item,fromRanges:[range]}]})
  if (message.method === 'callHierarchy/outgoingCalls') return send({jsonrpc:'2.0',id:message.id,result:[{to:item,fromRanges:[range]}]})
  send({jsonrpc:'2.0',id:message.id,result:null})
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const header = buffer.subarray(0, headerEnd).toString('ascii')
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1])
    const start = headerEnd + 4
    if (buffer.length < start + length) return
    const body = buffer.subarray(start, start + length)
    buffer = buffer.subarray(start + length)
    receive(JSON.parse(body.toString('utf8')))
  }
})
`

try {
  await detectClaudeVersion('LSP compatibility')
  await mkdir(join(plugin, '.claude-plugin'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  cwd = await realpath(cwd)
  await writeFile(sourceFile, 'int fixtureSymbol(void) { return 1; }\n')
  await writeFile(serverPath, fixtureServer)
  await writeFile(
    join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'lsp-fixture', version: '1.0.0' }),
  )
  await writeFile(
    join(plugin, '.lsp.json'),
    JSON.stringify({
      fixture: {
        command: process.execPath,
        args: [serverPath],
        env: { LSP_EVENT_LOG: serverLog },
        extensionToLanguage: { '.fixture': 'fixture' },
      },
    }),
  )
  await new Promise((resolve, reject) => {
    provider.once('error', reject)
    provider.listen(0, '127.0.0.1', resolve)
  })
  const address = provider.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const implementations = [
    {
      label: 'claude',
      command: 'claude',
      args: ['--plugin-dir', plugin],
      env: {
        ...process.env,
        ANTHROPIC_AUTH_TOKEN: 'fixture-key',
        ANTHROPIC_BASE_URL: baseUrl,
        CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
      },
    },
    {
      label: 'praxis',
      command: process.execPath,
      args: [join(process.cwd(), 'dist', 'cli.js'), '--plugin-dir', plugin],
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: join(root, 'praxis-config'),
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_API_KEY: 'fixture-key',
        PRAXIS_MODEL: 'fixture-model',
        PRAXIS_BASE_URL: `${baseUrl}/v1`,
      },
    },
  ]
  for (const implementation of implementations) {
    const headlessEnv = {
      ...implementation.env,
      CLAUDE_CONFIG_DIR: `${implementation.env.CLAUDE_CONFIG_DIR}-headless`,
    }
    const disabledEnv = {
      ...implementation.env,
      CLAUDE_CONFIG_DIR: `${implementation.env.CLAUDE_CONFIG_DIR}-disabled`,
    }
    const enabledEnv = {
      ...implementation.env,
      CLAUDE_CONFIG_DIR: `${implementation.env.CLAUDE_CONFIG_DIR}-enabled`,
    }
    if (implementation.label === 'claude') {
      await Promise.all(
        [headlessEnv, disabledEnv, enabledEnv].map((env) =>
          seedClaudeConfig(env.CLAUDE_CONFIG_DIR),
        ),
      )
    }
    await runHeadless(
      implementation.command,
      implementation.args,
      headlessEnv,
      `${implementation.label} headless LSP surface`,
    )
    await runTty(
      implementation.command,
      [...implementation.args, '--safe-mode', 'LSP_TOOL_DISABLED'],
      disabledEnv,
      `${implementation.label} disabled LSP surface`,
      disabledMarker,
      implementation.label === 'praxis',
    )
    if (implementation.label === 'praxis') {
      await runTty(
        implementation.command,
        [...implementation.args, '--bare', 'LSP_TOOL_DISABLED'],
        {
          ...implementation.env,
          CLAUDE_CONFIG_DIR: `${implementation.env.CLAUDE_CONFIG_DIR}-bare`,
        },
        'praxis bare LSP surface',
        disabledMarker,
        true,
      )
      await runTty(
        implementation.command,
        [
          ...implementation.args,
          '--disallowedTools',
          'LSP',
          '--',
          'LSP_TOOL_DISABLED',
        ],
        {
          ...implementation.env,
          CLAUDE_CONFIG_DIR: `${implementation.env.CLAUDE_CONFIG_DIR}-deny`,
        },
        'praxis denied LSP surface',
        disabledMarker,
        true,
      )
    }
    await runTty(
      implementation.command,
      [...implementation.args, 'LSP_TOOL_ROUND_TRIP'],
      enabledEnv,
      `${implementation.label} LSP round trip`,
      roundTripMarker,
      implementation.label === 'praxis',
    )
  }

  for (const label of ['claude', 'praxis']) {
    assert(
      !tool(requestFor('LSP_HEADLESS_SURFACE', `${label} headless`), 'LSP'),
      `${label} exposed LSP in headless mode`,
    )
  }
  const disabledRequests = requests.filter((request) =>
    JSON.stringify(request.messages ?? []).includes('LSP_TOOL_DISABLED'),
  )
  assert(
    disabledRequests.length >= 4,
    `Missing disabled LSP requests: ${JSON.stringify(requests.map((request) => JSON.stringify(request.messages ?? []).slice(-300)))}`,
  )
  assert(
    disabledRequests.every((request) => !tool(request, 'LSP')),
    'LSP was exposed in safe mode',
  )
  const roundTrips = requests.filter((request) =>
    JSON.stringify(request.messages ?? []).includes('LSP_TOOL_ROUND_TRIP'),
  )
  const initial = roundTrips.filter(
    (request) =>
      !JSON.stringify(request.messages ?? []).includes('tool_result'),
  )
  const completed = roundTrips.filter((request) => {
    const toolResults = (request.messages ?? []).flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((item) => item.type === 'tool_result')
        : [],
    )
    return toolResults.length === operations.length
  })
  assert(
    initial.length >= 2,
    `Missing enabled LSP request pair: ${initial.length}/${roundTrips.length}`,
  )
  assert(
    completed.length >= 2,
    `Missing complete LSP operation request pair: ${completed.length}/${roundTrips.length}`,
  )
  assert(
    completed.every((request) =>
      operations.every((operation) =>
        JSON.stringify(request.messages).includes(
          operation === 'hover' ? 'fixture hover' : 'fixtureSymbol',
        ),
      ),
    ),
    'All LSP operation results did not round-trip to both providers',
  )
  const resultSets = completed.map((request) =>
    toolResultContents(request).map(normalizedResult),
  )
  assert(
    resultSets.length === 2,
    `Expected one complete LSP result set per implementation, got ${resultSets.length}`,
  )
  assert(
    JSON.stringify(resultSets[0]) === JSON.stringify(resultSets[1]),
    `Claude/Praxis LSP formatted results diverge:\n${JSON.stringify(resultSets, null, 2)}`,
  )
  const withLsp = initial.filter((request) => tool(request, 'LSP'))
  assert(
    withLsp.length >= 2,
    `Enabled interactive request omitted LSP: ${JSON.stringify(initial.map((request) => ({ model: request.model, tools: (request.tools ?? []).map(({ name }) => name) })))}`,
  )
  const schemas = withLsp.map((request) => {
    const definition = tool(request, 'LSP')
    return normalized(definition.input_schema)
  })
  assert(
    JSON.stringify(schemas[0]) === JSON.stringify(schemas[1]),
    'Claude/Praxis LSP schemas diverge',
  )
  const events = (await readFile(serverLog, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).method)
  for (const method of [
    'initialize',
    'initialized',
    'textDocument/didOpen',
    'textDocument/documentSymbol',
    'shutdown',
  ]) {
    assert(
      events.filter((event) => event === method).length >= 2,
      `LSP lifecycle missing ${method}: ${JSON.stringify(events)}`,
    )
  }
  assert(
    events.includes('exit'),
    `Praxis LSP lifecycle omitted exit notification`,
  )
  assert(!failure, failure instanceof Error ? failure.message : String(failure))
  console.log(
    'LSP compatibility passed: exact Claude result formatting, interactive-only conditional exposure, safe/bare/deny exclusion, plugin server lifecycle, schema parity, document sync, tool round-trip, and bounded shutdown.',
  )
} finally {
  await appendFile(serverLog, '').catch(() => undefined)
  await new Promise((resolve) => provider.close(resolve))
  await rm(root, { recursive: true, force: true })
}
