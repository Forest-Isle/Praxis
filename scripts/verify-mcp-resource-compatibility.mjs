import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { detectClaudeVersion } from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-resource-compat-'))
const configRoot = join(root, 'config')
const ephemeralConfigRoot = join(root, 'ephemeral-config')
const noMcpConfigRoot = join(root, 'no-mcp-config')
const praxisConfigRoot = join(root, 'praxis-config')
const praxisEphemeralConfigRoot = join(root, 'praxis-ephemeral-config')
const cwd = join(root, 'work')
const mcpServer = join(root, 'mcp-server.mjs')
const mcpConfig = join(root, 'mcp.json')
const mcpLog = join(root, 'mcp.log')
const requests = []
const responses = []
const calls = [
  { id: 'list-all', name: 'ListMcpResourcesTool', input: {} },
  {
    id: 'list-one',
    name: 'ListMcpResourcesTool',
    input: { server: 'fixture' },
  },
  {
    id: 'list-missing',
    name: 'ListMcpResourcesTool',
    input: { server: 'missing' },
  },
  {
    id: 'list-failed',
    name: 'ListMcpResourcesTool',
    input: { server: 'broken' },
  },
  {
    id: 'list-tools-only',
    name: 'ListMcpResourcesTool',
    input: { server: 'tools_only' },
  },
  {
    id: 'read-text',
    name: 'ReadMcpResourceTool',
    input: { server: 'fixture', uri: 'fixture://alpha' },
  },
  {
    id: 'read-dir',
    name: 'ReadMcpResourceDirTool',
    input: { server: 'fixture', uri: 'fixture://directory' },
  },
  {
    id: 'read-dir-missing-server',
    name: 'ReadMcpResourceDirTool',
    input: { server: 'missing', uri: 'fixture://directory' },
  },
  {
    id: 'read-blob',
    name: 'ReadMcpResourceTool',
    input: { server: 'fixture', uri: 'fixture://blob' },
  },
  {
    id: 'read-missing-resource',
    name: 'ReadMcpResourceTool',
    input: { server: 'fixture', uri: 'fixture://missing' },
  },
  {
    id: 'read-failed-server',
    name: 'ReadMcpResourceTool',
    input: { server: 'broken', uri: 'fixture://alpha' },
  },
  {
    id: 'read-tools-only',
    name: 'ReadMcpResourceTool',
    input: { server: 'tools_only', uri: 'fixture://alpha' },
  },
  {
    id: 'read-missing-server',
    name: 'ReadMcpResourceTool',
    input: { server: 'missing', uri: 'fixture://alpha' },
  },
]

let messageNumber = 0

function messageStart() {
  messageNumber += 1
  return {
    type: 'message_start',
    message: {
      id: `msg_mcp_resource_${messageNumber}`,
      type: 'message',
      role: 'assistant',
      model: 'fixture-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  }
}

function toolEvents(call) {
  return [
    messageStart(),
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(call.input),
      },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]
}

function textEvents(text) {
  return [
    messageStart(),
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
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]
}

const provider = createServer(async (request, response) => {
  if (request.method === 'HEAD') {
    response.writeHead(200).end()
    return
  }
  let source = ''
  request.setEncoding('utf8')
  for await (const chunk of request) source += chunk
  if (!source || !request.url?.startsWith('/v1/messages')) {
    response.writeHead(404).end()
    return
  }
  requests.push(JSON.parse(source))
  const events = responses.shift()
  if (!events) throw new Error('MCP resource provider response queue exhausted')
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
  )
})

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function toolResults(runRequests, runCalls) {
  return runRequests
    .slice(1)
    .map((request, index) =>
      request.messages
        ?.flatMap((message) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .find(
          (block) =>
            block.type === 'tool_result' &&
            block.tool_use_id === runCalls[index]?.id,
        ),
    )
}

async function assertBlobResult(result, label) {
  assert(result?.is_error !== true, `${label} returned an error`)
  const contents = JSON.parse(result?.content ?? '{}').contents
  const expected = [
    ['fixture://blob', 'application/octet-stream', 'bin'],
    ['fixture://image', 'image/png', 'png'],
    ['fixture://pdf', 'application/pdf', 'pdf'],
    ['fixture://json', 'application/json', 'json'],
    ['fixture://text', 'text/plain', 'txt'],
  ]
  assert(
    Array.isArray(contents) && contents.length === expected.length,
    `${label} content count changed: ${JSON.stringify(contents)}`,
  )
  for (let index = 0; index < expected.length; index += 1) {
    const content = contents[index]
    const [uri, mimeType, extension] = expected[index]
    assert(content?.uri === uri, `${label} URI changed at ${index}`)
    assert(content?.mimeType === mimeType, `${label} MIME changed at ${index}`)
    assert(
      typeof content?.blobSavedTo === 'string' &&
        new RegExp(
          `tool-results/mcp-resource-\\d+-${index}-[a-z0-9]+\\.${extension}$`,
        ).test(content.blobSavedTo),
      `${label} output path changed at ${index}: ${JSON.stringify(content)}`,
    )
    assert(content?.blob === undefined, `${label} exposed blob at ${index}`)
    assert(
      Buffer.compare(
        await readFile(content.blobSavedTo),
        Buffer.from([1, 2, 3]),
      ) === 0,
      `${label} saved incorrect bytes at ${index}`,
    )
  }
}

async function assertResourceResults(results, label) {
  const expectedList =
    '[{"name":"Alpha","icons":[{"src":"fixture://icon","mimeType":"image/png","sizes":["16x16"]}],"uri":"fixture://alpha","description":"Alpha resource","mimeType":"text/plain","size":17,"annotations":{"audience":["assistant"],"priority":0.5,"lastModified":"2026-08-05T00:00:00Z"},"_meta":{"probe":"resource"},"server":"fixture"},{"name":"Directory","uri":"fixture://directory","description":"Directory resource","mimeType":"inode/directory","server":"fixture"}]'
  assert(results.length === calls.length, `${label} result count changed`)
  assert(
    results[0]?.content === expectedList,
    `${label} list-all changed: ${JSON.stringify(results[0])}`,
  )
  assert(results[1]?.content === expectedList, `${label} list-one changed`)
  assert(
    results[2]?.content ===
      'Server "missing" not found. Available servers: fixture, broken, tools_only' &&
      results[2]?.is_error === true,
    `${label} missing-server list changed: ${JSON.stringify(results[2])}`,
  )
  assert(
    results[3]?.content ===
      'No resources found. MCP servers may still provide tools even if they have no resources.' &&
      results[3]?.is_error !== true,
    `${label} failed-server list probe: ${JSON.stringify(results[3])}`,
  )
  assert(
    results[4]?.content ===
      'No resources found. MCP servers may still provide tools even if they have no resources.' &&
      results[4]?.is_error !== true,
    `${label} tools-only list changed: ${JSON.stringify(results[4])}`,
  )
  assert(
    results[5]?.content ===
      '{"contents":[{"uri":"fixture://alpha","mimeType":"text/plain","text":"RESOURCE_CONTENT"}]}' &&
      results[5]?.is_error !== true,
    `${label} text resource changed: ${JSON.stringify(results[5])}`,
  )
  assert(
    results[6]?.content === 'Directory listing is not enabled in this build.' &&
      results[6]?.is_error !== true,
    `${label} directory result changed`,
  )
  assert(
    results[7]?.content ===
      'Server "missing" not found. Available servers: fixture, broken, tools_only' &&
      results[7]?.is_error === true,
    `${label} unknown-server directory result changed: ${JSON.stringify(results[7])}`,
  )
  await assertBlobResult(results[8], `${label} blob resource`)
  assert(
    results[9]?.content ===
      'Resource not found: fixture://missing — it may have been deleted or the URI is stale. Re-run ListMcpResourcesTool to refresh.' &&
      results[9]?.is_error !== true,
    `${label} missing-resource result changed`,
  )
  assert(
    results[10]?.content === 'Server "broken" is not connected' &&
      results[10]?.is_error === true,
    `${label} failed-server read probe: ${JSON.stringify(results[10])}`,
  )
  assert(
    results[11]?.content === 'Server "tools_only" does not support resources' &&
      results[11]?.is_error === true,
    `${label} tools-only read probe: ${JSON.stringify(results[11])}`,
  )
  assert(
    results[12]?.content ===
      'Server "missing" not found. Available servers: fixture, broken, tools_only' &&
      results[12]?.is_error === true,
    `${label} missing-server read changed`,
  )
}

try {
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(ephemeralConfigRoot, { recursive: true }),
    mkdir(noMcpConfigRoot, { recursive: true }),
    mkdir(praxisConfigRoot, { recursive: true }),
    mkdir(praxisEphemeralConfigRoot, { recursive: true }),
    mkdir(cwd, { recursive: true }),
  ])
  await Promise.all([
    writeFile(
      mcpServer,
      `import { appendFileSync } from 'node:fs'
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  while (buffer.includes('\\n')) {
    const newline = buffer.indexOf('\\n')
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    appendFileSync(process.argv[2], JSON.stringify(request) + '\\n')
    if (request.id === undefined) continue
    const result = request.method === 'initialize'
      ? { protocolVersion: request.params.protocolVersion, capabilities: process.argv[3] === 'tools-only' ? { tools: {} } : { resources: {} }, serverInfo: { name: 'resource-fixture', version: '1' } }
      : request.method === 'tools/list'
        ? { tools: [] }
      : request.method === 'resources/list'
        ? request.params?.cursor === 'next'
          ? { resources: [{ uri: 'fixture://directory', name: 'Directory', description: 'Directory resource', mimeType: 'inode/directory' }] }
          : { resources: [{ uri: 'fixture://alpha', name: 'Alpha', description: 'Alpha resource', mimeType: 'text/plain', size: 17, annotations: { audience: ['assistant'], priority: 0.5, lastModified: '2026-08-05T00:00:00Z' }, icons: [{ src: 'fixture://icon', mimeType: 'image/png', sizes: ['16x16'] }], _meta: { probe: 'resource' } }], nextCursor: 'next' }
        : request.method === 'resources/templates/list'
          ? { resourceTemplates: [] }
          : request.method === 'resources/read'
            ? request.params.uri === 'fixture://blob'
              ? { contents: [{ uri: request.params.uri, mimeType: 'application/octet-stream', blob: 'AQID', _meta: { probe: 'blob' } }, { uri: 'fixture://image', mimeType: 'image/png', blob: 'AQID' }, { uri: 'fixture://pdf', mimeType: 'application/pdf', blob: 'AQID' }, { uri: 'fixture://json', mimeType: 'application/json', blob: 'AQID' }, { uri: 'fixture://text', mimeType: 'text/plain', blob: 'AQID' }], _meta: { probe: 'result' } }
              : { contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: 'RESOURCE_CONTENT', _meta: { probe: 'text' } }], _meta: { probe: 'result' } }
            : {}
    const response = request.method === 'resources/read' && request.params.uri === 'fixture://missing'
      ? { jsonrpc: '2.0', id: request.id, error: { code: -32002, message: 'RESOURCE_MISSING' } }
      : { jsonrpc: '2.0', id: request.id, result }
    process.stdout.write(JSON.stringify(response) + '\\n')
  }
})
`,
    ),
    writeFile(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          fixture: { command: process.execPath, args: [mcpServer, mcpLog] },
          broken: { command: join(root, 'missing-mcp-command') },
          tools_only: {
            command: process.execPath,
            args: [mcpServer, mcpLog, 'tools-only'],
          },
        },
      }),
    ),
    writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          fixture: { command: process.execPath, args: [mcpServer, mcpLog] },
          broken: { command: join(root, 'missing-mcp-command') },
          tools_only: {
            command: process.execPath,
            args: [mcpServer, mcpLog, 'tools-only'],
          },
        },
      }),
    ),
  ])
  await listen(provider)
  const address = provider.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  responses.push(
    ...calls.map((call) => toolEvents(call)),
    textEvents('MCP_RESOURCE_PROBE_DONE'),
  )
  await execFileAsync(
    'claude',
    [
      '-p',
      '--bare',
      '--permission-mode',
      'dontAsk',
      '--strict-mcp-config',
      '--mcp-config',
      mcpConfig,
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      String(calls.length + 1),
      '--output-format',
      'json',
      'return probe marker',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      timeout: 120_000,
    },
  )
  const configuredRequestCount = requests.length
  responses.push(
    ...calls.map((call) => toolEvents(call)),
    textEvents('PRAXIS_MCP_RESOURCE_PROBE_DONE'),
  )
  const praxisStart = requests.length
  const praxisSessionId = '77777777-7777-4777-8777-777777777777'
  const praxisExecution = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), 'dist', 'cli.js'),
      '-p',
      '--session-id',
      praxisSessionId,
      '--tools',
      'ListMcpResourcesTool,ReadMcpResourceDirTool,ReadMcpResourceTool',
      '--permission-mode',
      'dontAsk',
      '--output-format',
      'json',
      '--',
      'exercise MCP resources',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: praxisConfigRoot,
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_API_KEY: 'fixture-key',
        PRAXIS_MODEL: 'fixture-model',
        PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      },
      timeout: 120_000,
    },
  )
  const praxisRequestCount = requests.length
  responses.push(textEvents('CLAUDE_RESUMED_PRAXIS_MCP_RESOURCE'))
  const resumedExecution = await execFileAsync(
    'claude',
    [
      '-p',
      '--safe-mode',
      '--resume',
      praxisSessionId,
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      '1',
      '--tools=',
      '--output-format',
      'json',
      'resume MCP resource session',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: praxisConfigRoot,
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      timeout: 120_000,
    },
  )
  responses.push(textEvents('PRAXIS_MCP_STATUS_DONE'))
  const statusExecution = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), 'dist', 'cli.js'),
      '-p',
      '--no-session-persistence',
      '--tools',
      'ListMcpResourcesTool',
      '--verbose',
      '--output-format',
      'stream-json',
      '--',
      'report MCP status',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: praxisConfigRoot,
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_API_KEY: 'fixture-key',
        PRAXIS_MODEL: 'fixture-model',
        PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      },
      timeout: 120_000,
    },
  )
  responses.push(textEvents('CLAUDE_MCP_STATUS_DONE'))
  const claudeStatusExecution = await execFileAsync(
    'claude',
    [
      '-p',
      '--bare',
      '--strict-mcp-config',
      '--mcp-config',
      mcpConfig,
      '--no-session-persistence',
      '--verbose',
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      '1',
      '--output-format',
      'stream-json',
      'report MCP status',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      timeout: 120_000,
    },
  )
  responses.push(textEvents('NO_MCP_PROBE_DONE'))
  const noMcpStart = requests.length
  await execFileAsync(
    'claude',
    [
      '-p',
      '--safe-mode',
      '--dangerously-skip-permissions',
      '--tools',
      'default',
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      '1',
      '--output-format',
      'json',
      'return probe marker',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: noMcpConfigRoot,
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      timeout: 120_000,
    },
  )
  const ephemeralCall = {
    id: 'ephemeral-blob',
    name: 'ReadMcpResourceTool',
    input: { server: 'fixture', uri: 'fixture://blob' },
  }
  responses.push(
    toolEvents(ephemeralCall),
    textEvents('MCP_EPHEMERAL_RESOURCE_PROBE_DONE'),
  )
  const ephemeralStart = requests.length
  await execFileAsync(
    'claude',
    [
      '-p',
      '--bare',
      '--dangerously-skip-permissions',
      '--strict-mcp-config',
      '--mcp-config',
      mcpConfig,
      '--no-session-persistence',
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      '2',
      '--output-format',
      'json',
      'read blob resource',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: ephemeralConfigRoot,
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      timeout: 120_000,
    },
  )
  responses.push(
    toolEvents(ephemeralCall),
    textEvents('PRAXIS_EPHEMERAL_RESOURCE_PROBE_DONE'),
  )
  const praxisEphemeralStart = requests.length
  const praxisEphemeralExecution = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), 'dist', 'cli.js'),
      '-p',
      '--session-id',
      '88888888-8888-4888-8888-888888888888',
      '--no-session-persistence',
      '--tools',
      'ReadMcpResourceTool',
      '--permission-mode',
      'dontAsk',
      '--output-format',
      'json',
      '--',
      'read ephemeral blob resource',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: praxisEphemeralConfigRoot,
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_API_KEY: 'fixture-key',
        PRAXIS_MODEL: 'fixture-model',
        PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      },
      timeout: 120_000,
    },
  )
  const definitions = requests[0]?.tools?.filter((tool) =>
    /mcp|resource/i.test(tool.name),
  )
  const results = toolResults(requests.slice(0, configuredRequestCount), calls)
  const praxisDefinitions = requests[praxisStart]?.tools?.filter((tool) =>
    /mcp|resource/i.test(tool.name),
  )
  const praxisResults = toolResults(
    requests.slice(praxisStart, praxisRequestCount),
    calls,
  )
  const ephemeralResult = requests[ephemeralStart + 1]?.messages
    ?.flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .find(
      (block) =>
        block.type === 'tool_result' && block.tool_use_id === ephemeralCall.id,
    )
  const praxisEphemeralResult = requests[praxisEphemeralStart + 1]?.messages
    ?.flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .find(
      (block) =>
        block.type === 'tool_result' && block.tool_use_id === ephemeralCall.id,
    )
  assert(
    Array.isArray(definitions) && definitions.length === 3,
    'Claude MCP resource definitions changed',
  )
  assert(
    JSON.stringify(praxisDefinitions) === JSON.stringify(definitions),
    'Praxis MCP resource definitions differ from Claude',
  )
  assert(
    requests[noMcpStart]?.tools?.every(
      (tool) => !/mcp|resource/i.test(tool.name),
    ),
    'Claude exposed MCP resource tools without a resource server',
  )
  await assertResourceResults(results, 'Claude')
  await assertResourceResults(praxisResults, 'Praxis')
  const praxisResult = JSON.parse(praxisExecution.stdout)
  assert(
    praxisResult.session_id === praxisSessionId &&
      praxisResult.is_error === false &&
      praxisResult.result === 'PRAXIS_MCP_RESOURCE_PROBE_DONE',
    `Praxis MCP resource run failed: ${praxisExecution.stdout}`,
  )
  const resumedResult = JSON.parse(resumedExecution.stdout)
  assert(
    resumedResult.session_id === praxisSessionId &&
      resumedResult.is_error === false &&
      resumedResult.result === 'CLAUDE_RESUMED_PRAXIS_MCP_RESOURCE',
    `Claude could not resume Praxis MCP resource session: ${resumedExecution.stdout}`,
  )
  const statusRecords = statusExecution.stdout
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
  const init = statusRecords.find(
    (record) => record.type === 'system' && record.subtype === 'init',
  )
  assert(
    JSON.stringify(init?.mcp_servers) ===
      JSON.stringify([
        { name: 'fixture', status: 'connected' },
        { name: 'broken', status: 'failed' },
        { name: 'tools_only', status: 'connected' },
      ]),
    `Praxis stream init MCP status changed: ${JSON.stringify(init?.mcp_servers)}`,
  )
  const claudeStatusRecords = claudeStatusExecution.stdout
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
  const claudeInit = claudeStatusRecords.find(
    (record) => record.type === 'system' && record.subtype === 'init',
  )
  assert(
    JSON.stringify(claudeInit?.mcp_servers) ===
      JSON.stringify(init?.mcp_servers),
    `Claude/Praxis stream init MCP status differs: Claude=${JSON.stringify(claudeInit?.mcp_servers)} Praxis=${JSON.stringify(init?.mcp_servers)}`,
  )
  await assertBlobResult(ephemeralResult, 'Claude ephemeral blob resource')
  await assertBlobResult(
    praxisEphemeralResult,
    'Praxis ephemeral blob resource',
  )
  const praxisEphemeralEnvelope = JSON.parse(praxisEphemeralExecution.stdout)
  assert(
    praxisEphemeralEnvelope.is_error === false &&
      praxisEphemeralEnvelope.result === 'PRAXIS_EPHEMERAL_RESOURCE_PROBE_DONE',
    `Praxis ephemeral MCP resource run failed: ${praxisEphemeralExecution.stdout}`,
  )
  const ephemeralFiles = await readdir(ephemeralConfigRoot, { recursive: true })
  assert(
    !ephemeralFiles.some((path) => path.endsWith('.jsonl')),
    'Claude ephemeral MCP resource run wrote a transcript',
  )
  const praxisEphemeralFiles = await readdir(praxisEphemeralConfigRoot, {
    recursive: true,
  })
  assert(
    !praxisEphemeralFiles.some((path) => path.endsWith('.jsonl')),
    'Praxis ephemeral MCP resource run wrote a transcript',
  )
  const mcpRequests = (await readFile(mcpLog, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert(
    mcpRequests.filter((request) => request.method === 'resources/list')
      .length >= 6 &&
      mcpRequests.some(
        (request) =>
          request.method === 'resources/read' &&
          request.params?.uri === 'fixture://missing',
      ),
    'MCP resource pagination/read protocol coverage changed',
  )
  const version = await detectClaudeVersion('MCP resource compatibility probe')
  console.log(
    `Claude ${version} MCP resource compatibility passed: conditional schemas, paginated metadata list, text/blob/error reads, failed/tools-only states, directory stub, connected/failed status, Claude/Praxis ephemeral storage, persistence, and resume`,
  )
} finally {
  if (provider.listening) {
    await new Promise((resolve, reject) =>
      provider.close((error) => (error ? reject(error) : resolve())),
    )
  }
  await rm(root, { recursive: true, force: true })
}
