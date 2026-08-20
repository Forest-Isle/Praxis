import { execFile } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { detectClaudeVersion } from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-file-resources-'))
const cwd = join(root, 'work')
const configRoot = join(root, 'config')
const sessionId = '11111111-1111-4111-8111-111111111111'
const marker = 'STARTUP_FILE_MARKER_5801'
const providerRequests = []
const fileRequests = []
let providerTurn = 0

function messageStart() {
  providerTurn += 1
  return {
    type: 'message_start',
    message: {
      id: `msg_file_${providerTurn}`,
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

function toolEvents() {
  return [
    messageStart(),
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'read_startup_file',
        name: 'Read',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify({
          file_path: `${sessionId}/uploads/input.txt`,
        }),
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

function sendEvents(response, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
  )
}

const server = createServer(async (request, response) => {
  if (request.method === 'HEAD') {
    response.writeHead(200).end()
    return
  }
  if (request.url?.startsWith('/v1/files/')) {
    fileRequests.push({ url: request.url, headers: request.headers })
    if (request.url.includes('/missing/')) {
      response.writeHead(404).end('missing')
    } else {
      response.writeHead(200, {
        'content-type': 'text/plain',
        'content-length': Buffer.byteLength(marker),
      })
      response.end(marker)
    }
    return
  }
  if (!request.url?.startsWith('/v1/messages')) {
    response.writeHead(404).end()
    return
  }
  let source = ''
  request.setEncoding('utf8')
  for await (const chunk of request) source += chunk
  providerRequests.push(JSON.parse(source))
  sendEvents(
    response,
    providerRequests.length === 1
      ? toolEvents()
      : textEvents('FILE_RESOURCE_OK'),
  )
})

function listen() {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function closeServer() {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

try {
  await detectClaudeVersion()
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(configRoot, { recursive: true }),
  ])
  await listen()
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('File resource fixture server has no TCP address')
  }
  const baseUrl = `http://127.0.0.1:${address.port}`
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), 'dist/cli.js'),
      '-p',
      '--output-format=json',
      '--session-id',
      sessionId,
      '--file',
      'fixture:input.txt',
      'missing:missing.txt',
      '--',
      'read the startup file',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_API_KEY: 'provider-key',
        PRAXIS_FILES_BEARER_TOKEN: 'file-token',
        PRAXIS_FILES_BASE_URL: baseUrl,
        PRAXIS_MODEL: 'fixture-model',
        PRAXIS_BASE_URL: `${baseUrl}/v1`,
      },
      maxBuffer: 4 * 1024 * 1024,
    },
  )

  const result = JSON.parse(stdout)
  if (result.result !== 'FILE_RESOURCE_OK') {
    throw new Error(`Unexpected Praxis result: ${stdout}`)
  }
  if (!stderr.includes('File missing failed to download: HTTP 404')) {
    throw new Error(`Missing file warning was not emitted: ${stderr}`)
  }
  if (
    (await readFile(join(cwd, sessionId, 'uploads/input.txt'), 'utf8')) !==
    marker
  ) {
    throw new Error('Downloaded startup file content mismatch')
  }
  const toolResult = providerRequests[1]?.messages
    ?.flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .find(
      (block) =>
        block.type === 'tool_result' &&
        block.tool_use_id === 'read_startup_file',
    )
  if (!JSON.stringify(toolResult).includes(marker)) {
    throw new Error('Read tool could not discover downloaded startup file')
  }
  if (fileRequests.length !== 2) {
    throw new Error(`Expected 2 file requests, received ${fileRequests.length}`)
  }
  for (const request of fileRequests) {
    if (request.headers.authorization !== 'Bearer file-token') {
      throw new Error('File request did not use dedicated bearer token')
    }
    if (request.headers['anthropic-version'] !== '2023-06-01') {
      throw new Error('File request omitted Anthropic version header')
    }
    if (
      !String(request.headers['anthropic-beta']).includes(
        'files-api-2025-04-14',
      )
    ) {
      throw new Error('File request omitted Anthropic files beta header')
    }
    if (
      !String(request.headers['anthropic-beta']).includes('oauth-2025-04-20')
    ) {
      throw new Error('Bearer file request omitted Anthropic OAuth beta header')
    }
  }

  console.log(
    'File resource compatibility verified: startup download, safe session path, bearer auth, failure warning, and Read discovery.',
  )
} finally {
  await closeServer().catch(() => undefined)
  await rm(root, { recursive: true })
}
