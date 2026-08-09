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
const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-media-compat-'))
const mcpServer = join(root, 'mcp-server.mjs')
const mcpConfig = join(root, 'mcp.json')
const requests = []

const provider = createServer(async (request, response) => {
  if (request.method === 'HEAD') {
    response.writeHead(200).end()
    return
  }
  let source = ''
  request.setEncoding('utf8')
  for await (const chunk of request) source += chunk
  const providerRequest = JSON.parse(source)
  requests.push(providerRequest)
  const toolAvailable = providerRequest.tools?.some(
    (tool) => tool.name === 'mcp__fixture__media',
  )
  const hasToolResult = JSON.stringify(providerRequest.messages ?? []).includes(
    'call_media',
  )
  const events =
    toolAvailable && !hasToolResult
      ? [
          {
            type: 'message_start',
            message: {
              id: 'msg_media_tool',
              type: 'message',
              role: 'assistant',
              model: 'fixture-model',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'call_media',
              name: 'mcp__fixture__media',
              input: {},
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
      : [
          {
            type: 'message_start',
            message: {
              id: 'msg_media_done',
              type: 'message',
              role: 'assistant',
              model: 'fixture-model',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'MEDIA_DONE' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 1 },
          },
          { type: 'message_stop' },
        ]
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

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function jsonlFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await jsonlFiles(path)))
    else if (entry.name.endsWith('.jsonl')) files.push(path)
  }
  return files
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function messageBlocks(entry) {
  return Array.isArray(entry?.message?.content) ? entry.message.content : []
}

function normalizeBlocks(blocks) {
  return blocks.map((block) =>
    block.type === 'text'
      ? {
          ...block,
          text: block.text.replace(
            /saved to .*\.wav$/u,
            'saved to <audio-path>',
          ),
        }
      : block,
  )
}

async function runTarget(target, port) {
  const configRoot = join(root, `${target}-config`)
  const cwd = join(root, `${target}-work`)
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(cwd, { recursive: true }),
  ])
  const requestStart = requests.length
  const executable = target === 'claude' ? 'claude' : process.execPath
  const args = [
    ...(target === 'claude'
      ? ['-p', '--bare']
      : [join(process.cwd(), 'dist', 'cli.js'), 'run', '--json']),
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    'mcp__fixture__media',
    '--model',
    'claude-sonnet-4-5-20250929',
    ...(target === 'claude'
      ? ['--max-turns', '2', '--output-format', 'json']
      : []),
    'call media',
  ]
  const { stdout } = await execFileAsync(executable, args, {
    cwd,
    env: {
      ...process.env,
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CONFIG_DIR: configRoot,
      ANTHROPIC_API_KEY: 'fixture-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      PRAXIS_PROVIDER: 'anthropic',
      PRAXIS_API_KEY: 'fixture-key',
      PRAXIS_MODEL: 'claude-sonnet-4-5-20250929',
      PRAXIS_BASE_URL: `http://127.0.0.1:${port}`,
    },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  })
  assert(stdout.includes('MEDIA_DONE'), `${target} did not finish media turn`)

  const runRequests = requests.slice(requestStart)
  const providerResult = runRequests
    .flatMap((request) => request.messages ?? [])
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .find(
      (block) =>
        block.type === 'tool_result' && block.tool_use_id === 'call_media',
    )
  assert(
    Array.isArray(providerResult?.content),
    `${target} provider result missing`,
  )

  const files = await jsonlFiles(join(configRoot, 'projects'))
  const entries = (
    await Promise.all(
      files.map(async (path) =>
        (await readFile(path, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      ),
    )
  ).flat()
  const transcriptResult = entries.find(
    (entry) =>
      Array.isArray(entry.toolUseResult) &&
      messageBlocks(entry).some(
        (block) =>
          block.type === 'tool_result' && block.tool_use_id === 'call_media',
      ),
  )
  assert(transcriptResult, `${target} transcript result missing`)
  const initialPrompt = entries.find(
    (entry) =>
      entry.type === 'user' &&
      typeof entry.promptId === 'string' &&
      !messageBlocks(entry).some((block) => block.type === 'tool_result'),
  )
  assert(
    initialPrompt?.promptId === transcriptResult.promptId,
    `${target} tool result did not reuse promptId`,
  )
  assert(
    JSON.stringify(transcriptResult.toolUseResult) ===
      JSON.stringify(providerResult.content),
    `${target} transcript/provider block order diverged`,
  )
  assert(
    transcriptResult.mcpMeta?.structuredContent?.value === 'STRUCTURED_MARKER',
    `${target} structured MCP metadata missing`,
  )
  const attributedAssistant = entries.find(
    (entry) =>
      entry.type === 'assistant' &&
      entry.attributionMcpServer === 'fixture' &&
      entry.attributionMcpTool === 'media',
  )
  assert(attributedAssistant, `${target} assistant MCP attribution missing`)
  const audioBlock = providerResult.content.find(
    (block) =>
      block.type === 'text' && block.text.includes('[Audio from fixture]'),
  )
  const audioPath = /saved to (.*\.wav)$/u.exec(audioBlock?.text ?? '')?.[1]
  assert(audioPath, `${target} audio output path missing`)
  assert(
    (await readFile(audioPath)).equals(Buffer.from('RIFF')),
    `${target} audio output bytes changed`,
  )
  return normalizeBlocks(providerResult.content)
}

try {
  const version = await detectClaudeVersion('MCP media compatibility probe')
  await listen(provider)
  const address = provider.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  await writeFile(
    mcpServer,
    `let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  while (buffer.includes('\\n')) {
    const newline = buffer.indexOf('\\n')
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.id === undefined) continue
    const result = request.method === 'initialize'
      ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'media-fixture', version: '1' } }
      : request.method === 'tools/list'
        ? { tools: [{ name: 'media', description: 'Return text and image.', inputSchema: { type: 'object', additionalProperties: false } }] }
        : { content: [{ type: 'text', text: 'IMAGE_MARKER' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }, { type: 'audio', mimeType: 'audio/wav', data: 'UklGRg==' }, { type: 'resource_link', uri: 'fixture://linked', name: 'Linked', mimeType: 'text/plain' }, { type: 'resource', resource: { uri: 'fixture://embedded', mimeType: 'text/plain', text: 'EMBEDDED_MARKER' } }], structuredContent: { value: 'STRUCTURED_MARKER' } }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
  }
})
`,
  )
  await writeFile(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        fixture: { command: process.execPath, args: [mcpServer] },
      },
    }),
  )
  const claudeBlocks = await runTarget('claude', address.port)
  const praxisBlocks = await runTarget('praxis', address.port)
  assert(
    JSON.stringify(praxisBlocks) === JSON.stringify(claudeBlocks),
    `MCP media provider envelope diverged:\nClaude ${JSON.stringify(claudeBlocks)}\nPraxis ${JSON.stringify(praxisBlocks)}`,
  )
  console.log(`MCP media compatibility passed for Claude ${version}.`)
} finally {
  if (provider.listening) await close(provider)
  await rm(root, { recursive: true })
}
