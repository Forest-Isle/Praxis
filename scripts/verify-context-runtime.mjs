import { execFile } from 'node:child_process'
import { readFile, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  resolveClaudePaths,
  sanitizeClaudeProjectPath,
} from '../dist/compatibility/claude/paths.js'
import { writeFixture as write } from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const probeRoot = await mkdtemp(join(tmpdir(), 'praxis-context-runtime-'))
const requests = []
let responseNumber = 0

const server = createServer(async (request, response) => {
  let body = ''
  request.setEncoding('utf8')
  for await (const chunk of request) body += chunk
  requests.push(JSON.parse(body))
  responseNumber += 1
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    `data: ${JSON.stringify({ choices: [{ delta: { content: `CONTEXT_RUNTIME_ANSWER_${responseNumber}` }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
  )
})

function listen() {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
}

function closeServer() {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function resultRecord(stdout) {
  const records = stdout
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
  const result = records.find((record) => record.type === 'result')
  if (!result || typeof result.sessionId !== 'string') {
    throw new Error(`Praxis CLI emitted no result record: ${stdout}`)
  }
  return result
}

function systemContent(request) {
  const messages = request?.messages?.filter(
    (message) =>
      message?.role === 'system' && typeof message.content === 'string',
  )
  if (!messages?.length) {
    throw new Error(
      `Provider received no system context: ${JSON.stringify(request)}`,
    )
  }
  return messages.map((message) => message.content).join('\n\n')
}

function assertContains(content, marker, label) {
  if (!content.includes(marker)) throw new Error(`${label} missing ${marker}`)
}

function assertNotContains(content, marker, label) {
  if (content.includes(marker)) throw new Error(`${label} leaked ${marker}`)
}

try {
  const configRoot = join(probeRoot, 'config')
  const workDirectory = join(probeRoot, 'work')
  await write(join(workDirectory, '.keep'), '')
  const cwd = await realpath(workDirectory)
  const memoryDirectory = join(
    configRoot,
    'projects',
    sanitizeClaudeProjectPath(cwd),
    'memory',
  )
  const globalMarker = 'CONTEXT_RUNTIME_GLOBAL_1042'
  const firstProjectMarker = 'CONTEXT_RUNTIME_PROJECT_FIRST_2053'
  const updatedProjectMarker = 'CONTEXT_RUNTIME_PROJECT_UPDATED_3064'
  const memoryMarker = 'CONTEXT_RUNTIME_MEMORY_4075'
  const memoryDetailMarker = 'CONTEXT_RUNTIME_MEMORY_DETAIL_5086'
  await Promise.all([
    write(join(configRoot, 'CLAUDE.md'), globalMarker),
    write(join(cwd, 'CLAUDE.md'), firstProjectMarker),
    write(join(memoryDirectory, 'MEMORY.md'), memoryMarker),
    write(join(memoryDirectory, 'details.md'), memoryDetailMarker),
  ])

  await listen()
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Context runtime fixture server has no TCP address')
  }
  const environment = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configRoot,
    PRAXIS_API_KEY: 'fixture-key',
    PRAXIS_MODEL: 'fixture-model',
    PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
  }
  const cliPath = join(process.cwd(), 'dist', 'cli.js')
  const firstRun = await execFileAsync(
    process.execPath,
    [cliPath, 'run', '--json', 'Inspect shared context'],
    { cwd, env: environment },
  )
  const firstResult = resultRecord(firstRun.stdout)
  const firstContext = systemContent(requests[0])
  assertContains(firstContext, globalMarker, 'Initial system context')
  assertContains(firstContext, firstProjectMarker, 'Initial system context')
  assertContains(firstContext, memoryMarker, 'Initial system context')
  assertNotContains(firstContext, memoryDetailMarker, 'Initial system context')

  await write(join(cwd, 'CLAUDE.md'), updatedProjectMarker)
  await execFileAsync(
    process.execPath,
    [
      cliPath,
      'resume',
      '--json',
      firstResult.sessionId,
      'Inspect updated context',
    ],
    { cwd, env: environment },
  )
  const resumedContext = systemContent(requests[1])
  assertContains(resumedContext, updatedProjectMarker, 'Resumed system context')
  assertNotContains(
    resumedContext,
    firstProjectMarker,
    'Resumed system context',
  )

  const transcriptPath = resolveClaudePaths({
    configDir: configRoot,
    cwd,
    sessionId: firstResult.sessionId,
  }).sessionFile
  const transcript = await readFile(transcriptPath, 'utf8')
  for (const marker of [
    globalMarker,
    firstProjectMarker,
    updatedProjectMarker,
    memoryMarker,
    memoryDetailMarker,
  ]) {
    assertNotContains(transcript, marker, 'Shared transcript')
  }

  console.log(
    'Praxis context runtime passed: built CLI wiring, run/resume reload, provider system context, and transcript isolation',
  )
} finally {
  if (server.listening) await closeServer()
  await rm(probeRoot, { recursive: true })
}
