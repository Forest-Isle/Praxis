import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import { detectClaudeVersion, execFileAsync } from './lib/claude-probe.mjs'

const root = await mkdtemp(join(tmpdir(), 'praxis-rewind-files-compat-'))
let cwd = join(root, 'work')
const claudeConfigRoot = join(root, 'claude-config')
const praxisConfigRoot = join(root, 'praxis-config')
const responses = []
let messageNumber = 0
let providerRequests = 0

function messageStart() {
  messageNumber += 1
  return {
    type: 'message_start',
    message: {
      id: `msg_rewind_${messageNumber}`,
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

function toolEvents(id, filePath) {
  return [
    messageStart(),
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id, name: 'Write', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify({
          file_path: filePath,
          content: 'created\n',
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

const server = createServer(async (request, response) => {
  if (request.method === 'HEAD') {
    response.writeHead(200).end()
    return
  }
  for await (const chunk of request) void chunk
  const events = responses.shift()
  if (!events) {
    response.writeHead(500).end()
    return
  }
  providerRequests += 1
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

async function userMessageId(configRoot, sessionId) {
  const sessionFile = resolveClaudePaths({
    configDir: configRoot,
    cwd,
    sessionId,
  }).sessionFile
  const source = await readFile(sessionFile, 'utf8')
  const entries = source.trim().split('\n').map(JSON.parse)
  const user = entries.find(
    (entry) =>
      entry.type === 'user' && typeof entry.message?.content === 'string',
  )
  if (typeof user?.uuid !== 'string') {
    throw new Error(`Session ${sessionId} has no user message UUID`)
  }
  if (
    !entries.some(
      (entry) =>
        entry.type === 'file-history-snapshot' && entry.messageId === user.uuid,
    ) ||
    !entries.some((entry) => entry.type === 'file-history-delta')
  ) {
    throw new Error(`Session ${sessionId} has no native file history`)
  }
  return user.uuid
}

async function assertMissing(path, label) {
  try {
    await readFile(path)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new Error(`${label} was not removed by rewind`)
}

async function captureFailure(command, args, options) {
  try {
    await execFileAsync(command, args, options)
  } catch (error) {
    return {
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message),
    }
  }
  throw new Error(`${command} unexpectedly succeeded`)
}

try {
  const version = await detectClaudeVersion('file rewind compatibility')
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(claudeConfigRoot, { recursive: true }),
    mkdir(praxisConfigRoot, { recursive: true }),
  ])
  cwd = await realpath(cwd)
  await listen()
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('No fixture address')
  }
  const origin = `http://127.0.0.1:${address.port}`
  const checkpointEnvironment = {
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'true',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  const claudeEnvironment = {
    ...process.env,
    ...checkpointEnvironment,
    CLAUDE_CONFIG_DIR: claudeConfigRoot,
    ANTHROPIC_BASE_URL: origin,
    ANTHROPIC_API_KEY: 'fixture-key',
  }
  const praxisEnvironment = {
    ...process.env,
    ...checkpointEnvironment,
    CLAUDE_CONFIG_DIR: praxisConfigRoot,
    PRAXIS_PROVIDER: 'anthropic',
    PRAXIS_BASE_URL: `${origin}/v1`,
    PRAXIS_API_KEY: 'fixture-key',
    PRAXIS_MODEL: 'fixture-model',
  }

  const claudeFile = join(cwd, 'claude-created.txt')
  responses.push(
    toolEvents('claude-write', claudeFile),
    textEvents('CLAUDE_CHECKPOINT_DONE'),
  )
  const claudeRun = await execFileAsync(
    'claude',
    [
      '-p',
      '--dangerously-skip-permissions',
      '--tools',
      'Write',
      '--max-turns',
      '2',
      '--output-format',
      'json',
      'create checkpoint',
    ],
    { cwd, env: claudeEnvironment, timeout: 120_000 },
  )
  const claudeResult = JSON.parse(claudeRun.stdout)
  const claudeUserId = await userMessageId(
    claudeConfigRoot,
    claudeResult.session_id,
  )
  const beforePraxisRewindRequests = providerRequests
  const praxisRewind = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), 'dist', 'cli.js'),
      '-p',
      '--resume',
      claudeResult.session_id,
      '--rewind-files',
      claudeUserId,
    ],
    { cwd, env: { ...praxisEnvironment, CLAUDE_CONFIG_DIR: claudeConfigRoot } },
  )
  if (
    praxisRewind.stdout !==
    `Files rewound to state at message ${claudeUserId}\n`
  ) {
    throw new Error(`Unexpected Praxis rewind output: ${praxisRewind.stdout}`)
  }
  await assertMissing(claudeFile, 'Claude-created file')
  if (providerRequests !== beforePraxisRewindRequests) {
    throw new Error('Praxis rewind called the provider')
  }

  const praxisFile = join(cwd, 'praxis-created.txt')
  responses.push(
    toolEvents('praxis-write', praxisFile),
    textEvents('PRAXIS_CHECKPOINT_DONE'),
  )
  const praxisRun = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), 'dist', 'cli.js'),
      '-p',
      '--dangerously-skip-permissions',
      '--tools',
      'Write',
      '--max-turns',
      '2',
      '--output-format',
      'json',
      '--',
      'create checkpoint',
    ],
    { cwd, env: praxisEnvironment, timeout: 120_000 },
  )
  const praxisResult = JSON.parse(praxisRun.stdout)
  const praxisUserId = await userMessageId(
    praxisConfigRoot,
    praxisResult.session_id,
  )
  const beforeClaudeRewindRequests = providerRequests
  const claudeRewind = await execFileAsync(
    'claude',
    ['-p', '--resume', praxisResult.session_id, '--rewind-files', praxisUserId],
    { cwd, env: { ...claudeEnvironment, CLAUDE_CONFIG_DIR: praxisConfigRoot } },
  )
  if (
    claudeRewind.stdout !==
    `Files rewound to state at message ${praxisUserId}\n`
  ) {
    throw new Error(`Unexpected Claude rewind output: ${claudeRewind.stdout}`)
  }
  await assertMissing(praxisFile, 'Praxis-created file')
  if (providerRequests !== beforeClaudeRewindRequests) {
    throw new Error('Claude rewind called the provider')
  }

  const missingResume = await captureFailure(
    'claude',
    ['-p', '--rewind-files', randomUUID()],
    { cwd, env: claudeEnvironment },
  )
  const praxisMissingResume = await captureFailure(
    process.execPath,
    [
      join(process.cwd(), 'dist', 'cli.js'),
      '-p',
      '--rewind-files',
      randomUUID(),
    ],
    { cwd, env: praxisEnvironment },
  )
  if (
    !missingResume.stderr.includes('--rewind-files requires --resume') ||
    !praxisMissingResume.stderr.includes('--rewind-files requires --resume')
  ) {
    throw new Error('Claude/Praxis missing-resume errors differ')
  }

  console.log(
    `Claude ${version} file rewind compatibility passed: native snapshots/deltas, bidirectional restoration, standalone output, validation, and provider isolation.`,
  )
} finally {
  if (server.listening) await closeServer().catch(() => undefined)
  await rm(root, { recursive: true })
}
