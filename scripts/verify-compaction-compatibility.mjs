import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import {
  assertContains,
  assertNotContains,
  detectClaudeVersion,
  runClaudeJson,
} from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const root = await realpath(
  await mkdtemp(join(tmpdir(), 'praxis-compaction-compat-')),
)
const configRoot = join(root, 'config')
const workDirectory = join(root, 'work')
const retainedMarker = 'COMPACT_KEEP_8642'
const droppedMarker = 'DROPPED_HISTORY_9753'
const finalMarker = 'PRAXIS_COMPACT_DONE_2468'
const originMarker = 'PRAXIS_COMPACT_ORIGIN_1357'
let mainRequestMessages = ''
let requestCount = 0

const server = createServer(async (request, response) => {
  let body = ''
  request.setEncoding('utf8')
  for await (const chunk of request) body += chunk
  const payload = JSON.parse(body)
  requestCount += 1
  const messages = JSON.stringify(payload.messages ?? [])
  const compacting = messages.includes(
    'You are compacting an agent conversation',
  )
  const content = compacting
    ? retainedMarker
    : requestCount === 1
      ? originMarker
      : finalMarker
  if (!compacting && requestCount > 1) mainRequestMessages = messages
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 4 } })}\n\ndata: [DONE]\n\n`,
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
  const version = await detectClaudeVersion('Compaction compatibility probe')
  await mkdir(workDirectory, { recursive: true })
  await listen()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')

  const cli = join(process.cwd(), 'dist', 'cli.js')
  const prompt = `Keep the current task. ${droppedMarker} ${'old-context '.repeat(700)}`
  const { stdout: originStdout } = await execFileAsync(
    process.execPath,
    [cli, 'run', '--json', prompt],
    {
      cwd: workDirectory,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        PRAXIS_API_KEY: 'fixture-key',
        PRAXIS_MODEL: 'fixture-model',
        PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
    },
  )
  const originRecords = originStdout
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
  const origin = originRecords.find((record) => record.type === 'result')
  if (!origin || typeof origin.sessionId !== 'string') {
    throw new Error(`Praxis origin did not return a session: ${originStdout}`)
  }

  const { stdout } = await execFileAsync(
    process.execPath,
    [cli, 'resume', '--json', origin.sessionId, 'Continue the task.'],
    {
      cwd: workDirectory,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        PRAXIS_API_KEY: 'fixture-key',
        PRAXIS_MODEL: 'fixture-model',
        PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        PRAXIS_CONTEXT_WINDOW_TOKENS: '4000',
        PRAXIS_CONTEXT_RESERVE_TOKENS: '3000',
      },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
    },
  )
  const records = stdout
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
  const result = records.find((record) => record.type === 'result')
  if (!result || result.sessionId !== origin.sessionId) {
    throw new Error(`Praxis compaction resume failed: ${stdout}`)
  }
  if (requestCount !== 3) {
    throw new Error(
      `Expected origin, compaction, and model requests; received ${requestCount}`,
    )
  }
  assertContains(mainRequestMessages, retainedMarker, 'Praxis compact request')
  assertNotContains(
    mainRequestMessages,
    droppedMarker,
    'Praxis compact request',
  )

  const transcriptPath = resolveClaudePaths({
    configDir: configRoot,
    cwd: workDirectory,
    sessionId: result.sessionId,
  }).sessionFile
  const transcript = await readFile(transcriptPath, 'utf8')
  assertContains(transcript, droppedMarker, 'Append-only transcript')
  assertContains(transcript, '"subtype":"compact_boundary"', 'Compact boundary')
  assertContains(transcript, '"isCompactSummary":true', 'Compact summary')

  const claude = await runClaudeJson(
    [
      '-p',
      '--resume',
      result.sessionId,
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--output-format',
      'json',
      'Return the token matching COMPACT_KEEP_[0-9]+ from active context. Also return any token matching DROPPED_HISTORY_[0-9]+ only if it exists in active context.',
    ],
    workDirectory,
    configRoot,
  )
  const claudeResult = String(claude.result)
  assertContains(claudeResult, retainedMarker, 'Claude compact resume')
  assertNotContains(claudeResult, droppedMarker, 'Claude compact resume')

  console.log(
    `Claude ${version} compaction compatibility passed: Praxis compact write, active-context projection, and Claude resume`,
  )
} finally {
  if (server.listening) await closeServer()
  await rm(root, { recursive: true })
}
