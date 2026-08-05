import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { detectClaudeVersion } from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-notebook-compat-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'work')
const requests = []
const responses = []
let messageNumber = 0

function messageStart() {
  messageNumber += 1
  return {
    type: 'message_start',
    message: {
      id: `msg_notebook_${messageNumber}`,
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

function toolEvents(id, name, input) {
  return [
    messageStart(),
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id, name, input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
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

const server = createServer(async (request, response) => {
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
  if (!events) throw new Error('Notebook provider response queue exhausted')
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
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

function notebook(source) {
  return `${JSON.stringify(
    {
      cells: [
        {
          cell_type: 'markdown',
          id: 'intro',
          metadata: { retained: true },
          source,
        },
      ],
      metadata: { retained: true },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  )}\n`
}

function toolResult(request, id) {
  return request.messages
    ?.flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .find((block) => block.type === 'tool_result' && block.tool_use_id === id)
}

function toolResultText(result) {
  if (typeof result?.content === 'string') return result.content
  if (!Array.isArray(result?.content)) return undefined
  return result.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

try {
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(cwd, { recursive: true }),
  ])
  await listen()
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Notebook fixture server has no TCP address')
  }
  const baseUrl = `http://127.0.0.1:${address.port}`
  const claudePath = join(cwd, 'claude.ipynb')
  await writeFile(claudePath, notebook('# Claude old'))
  responses.push(
    toolEvents('claude-read', 'Read', { file_path: claudePath }),
    toolEvents('claude-edit', 'NotebookEdit', {
      notebook_path: claudePath,
      cell_id: 'intro',
      new_source: '# Claude new',
      edit_mode: 'replace',
    }),
    textEvents('CLAUDE_NOTEBOOK_DONE'),
  )
  const claudeStart = requests.length
  await execFileAsync(
    'claude',
    [
      '-p',
      '--safe-mode',
      '--dangerously-skip-permissions',
      '--tools',
      'Read,NotebookEdit',
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      '3',
      '--output-format',
      'json',
      'edit notebook',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: baseUrl,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    },
  )
  const claudeRequests = requests.slice(claudeStart)
  assert(
    toolResultText(toolResult(claudeRequests[1], 'claude-read')) ===
      '<cell id="intro"><cell_type>markdown</cell_type># Claude old</cell id="intro">',
    'Claude notebook Read envelope changed',
  )
  assert(
    toolResultText(toolResult(claudeRequests[2], 'claude-edit')) ===
      'Updated cell intro with # Claude new',
    'Claude NotebookEdit result changed',
  )
  assert(
    JSON.parse(await readFile(claudePath, 'utf8')).cells[0].source ===
      '# Claude new',
    'Claude did not update notebook source',
  )

  const praxisPath = join(cwd, 'praxis.ipynb')
  const sessionId = '55555555-5555-4555-8555-555555555555'
  await writeFile(praxisPath, notebook('# Praxis old'))
  responses.push(
    toolEvents('praxis-read', 'Read', { file_path: praxisPath }),
    toolEvents('praxis-edit', 'NotebookEdit', {
      notebook_path: praxisPath,
      cell_id: 'intro',
      new_source: '# Praxis new',
      edit_mode: 'replace',
    }),
    textEvents('PRAXIS_NOTEBOOK_DONE'),
  )
  const praxisStart = requests.length
  const praxisExecution = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), 'dist', 'cli.js'),
      '-p',
      '--session-id',
      sessionId,
      '--dangerously-skip-permissions',
      '--tools',
      'Read,NotebookEdit',
      '--output-format',
      'json',
      '--',
      'edit notebook',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_API_KEY: 'fixture-key',
        PRAXIS_MODEL: 'fixture-model',
        PRAXIS_BASE_URL: `${baseUrl}/v1`,
      },
    },
  )
  const praxisResult = JSON.parse(praxisExecution.stdout)
  const praxisRequests = requests.slice(praxisStart)
  assert(
    praxisResult.session_id === sessionId && praxisResult.is_error === false,
    `Praxis notebook run failed: ${praxisExecution.stdout}`,
  )
  assert(
    toolResultText(toolResult(praxisRequests[1], 'praxis-read')) ===
      '<cell id="intro"><cell_type>markdown</cell_type># Praxis old</cell id="intro">',
    'Praxis notebook Read envelope differs from Claude',
  )
  assert(
    toolResultText(toolResult(praxisRequests[2], 'praxis-edit')) ===
      'Updated cell intro with # Praxis new',
    'Praxis NotebookEdit result differs from Claude',
  )
  assert(
    JSON.parse(await readFile(praxisPath, 'utf8')).cells[0].source ===
      '# Praxis new',
    'Praxis did not update notebook source',
  )

  responses.push(textEvents('CLAUDE_RESUMED_PRAXIS_NOTEBOOK'))
  const resumed = await execFileAsync(
    'claude',
    [
      '-p',
      '--resume',
      sessionId,
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      '1',
      '--tools=',
      '--output-format',
      'json',
      'resume notebook session',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: baseUrl,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    },
  )
  const resumedResult = JSON.parse(resumed.stdout)
  assert(
    resumedResult.session_id === sessionId && resumedResult.is_error === false,
    `Claude could not resume Praxis notebook session: ${resumed.stdout}`,
  )
  const version = await detectClaudeVersion('Notebook compatibility probe')
  console.log(
    `Claude ${version} notebook compatibility passed: native Read view, replace writeback, Praxis tool round trip, and Claude resume`,
  )
} finally {
  if (server.listening) await closeServer()
  await rm(root, { recursive: true, force: true })
}
