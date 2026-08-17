import { randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import { parseClaudeVersionOutput } from '../dist/compatibility/claude/schema.js'
import { execFileAsync } from './lib/claude-probe.mjs'

const REFERENCE_VERSION = '2.1.208'
const referenceBinary = process.env.PRAXIS_CLAUDE_BINARY
const crossBinary = process.env.PRAXIS_CLAUDE_CROSS_VERSION_BINARY

if (!referenceBinary) {
  throw new Error(
    'PRAXIS_CLAUDE_BINARY must point to the Claude Code 2.1.208 executable',
  )
}
if (!crossBinary) {
  throw new Error(
    'PRAXIS_CLAUDE_CROSS_VERSION_BINARY must point to a second Claude Code executable',
  )
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function detectVersion(executable, label) {
  let result
  try {
    result = await execFileAsync(executable, ['--version'], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    })
  } catch (error) {
    throw new Error(
      `${label} at ${executable} could not run: ${error.message ?? error}`,
    )
  }
  return parseClaudeVersionOutput(result.stdout)
}

const turnMarkers = [
  ['FIRST_PROMPT', 'FIRST_ANSWER'],
  ['SECOND_PROMPT', 'SECOND_ANSWER'],
  ['ABANDONED_PROMPT', 'ABANDONED_ANSWER'],
  ['PRAXIS_BRANCH_PROMPT', 'PRAXIS_BRANCH_ANSWER'],
  ['CROSS_BRANCH_PROMPT', 'CROSS_BRANCH_ANSWER'],
  ['PRAXIS_FINAL_PROMPT', 'PRAXIS_FINAL_ANSWER'],
]

function responseText(body) {
  const source = JSON.stringify(body.messages ?? [])
  const matched = turnMarkers.findLast(([marker]) => source.includes(marker))
  return matched?.[1] ?? 'ANSWER'
}

function textEvents(text) {
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_cross_version_${randomUUID().replaceAll('-', '')}`,
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

const requests = []
const malformed = []
let mode = 'setup'

const server = createServer(async (request, response) => {
  if (request.method === 'HEAD') {
    response.writeHead(200).end()
    return
  }
  if (!request.url?.startsWith('/v1/messages')) {
    response.writeHead(404).end()
    return
  }
  let source = ''
  request.setEncoding('utf8')
  for await (const chunk of request) source += chunk
  let body
  try {
    body = JSON.parse(source)
  } catch {
    malformed.push(source)
    response.writeHead(400, { 'content-type': 'text/plain' }).end('malformed')
    return
  }
  requests.push({ mode, body })
  const events = textEvents(responseText(body))
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

function requestFor(requestMode) {
  const request = requests.findLast(
    (candidate) => candidate.mode === requestMode,
  )
  if (!request) throw new Error(`Provider request missing for ${requestMode}`)
  return JSON.stringify(request.body.messages ?? [])
}

function assertBranchContext(requestMode, prompt) {
  const source = requestFor(requestMode)
  for (const marker of [
    'FIRST_PROMPT',
    'FIRST_ANSWER',
    'SECOND_PROMPT',
    prompt,
  ]) {
    assert(source.includes(marker), `${requestMode} omitted ${marker}`)
  }
  for (const marker of [
    'SECOND_ANSWER',
    'ABANDONED_PROMPT',
    'ABANDONED_ANSWER',
  ]) {
    assert(!source.includes(marker), `${requestMode} retained ${marker}`)
  }
}

async function entries(path) {
  return (await readFile(path, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
}

function messageEntry(transcript, content) {
  const entry = transcript.find(
    (candidate) =>
      candidate.type === 'user' && candidate.message?.content === content,
  )
  if (!entry || typeof entry.uuid !== 'string') {
    throw new Error(`Transcript message missing: ${content}`)
  }
  return entry
}

async function runClaude(executable, args, cwd, configRoot, extraEnv) {
  const { stdout } = await execFileAsync(executable, args, {
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
      CLAUDE_CONFIG_DIR: configRoot,
    },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  })
  return JSON.parse(stdout)
}

const root = await mkdtemp(join(tmpdir(), 'praxis-cross-version-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'work')

try {
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(configRoot, { recursive: true }),
  ])
  const canonicalCwd = await realpath(cwd)

  const referenceVersion = await detectVersion(
    referenceBinary,
    'reference Claude CLI',
  )
  const crossVersion = await detectVersion(
    crossBinary,
    'cross-version Claude CLI',
  )
  assert(
    referenceVersion === REFERENCE_VERSION,
    `Reference Claude CLI must be ${REFERENCE_VERSION}, got ${referenceVersion}`,
  )
  assert(
    crossVersion !== REFERENCE_VERSION,
    `Cross-version Claude CLI must differ from ${REFERENCE_VERSION}, got ${crossVersion}`,
  )

  await listen()
  const address = server.address()
  assert(
    address !== null && typeof address !== 'string',
    'Cross-version fixture server has no TCP address',
  )

  const claudeEnv = {
    ANTHROPIC_API_KEY: 'fixture-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  }
  const praxisEnv = {
    PRAXIS_PROVIDER: 'anthropic',
    PRAXIS_API_KEY: 'fixture-key',
    PRAXIS_MODEL: 'fixture-model',
    PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
  }
  const claudeCommon = [
    '-p',
    '--model',
    'haiku',
    '--max-turns',
    '1',
    '--tools',
    '',
    '--output-format',
    'json',
  ]
  const praxis = (...args) =>
    execFileAsync(
      process.execPath,
      [join(process.cwd(), 'dist/cli.js'), ...args],
      {
        cwd: canonicalCwd,
        env: { ...process.env, ...praxisEnv, CLAUDE_CONFIG_DIR: configRoot },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
      },
    )

  mode = 'claude-turn-1'
  const first = await runClaude(
    referenceBinary,
    [...claudeCommon, 'FIRST_PROMPT'],
    canonicalCwd,
    configRoot,
    claudeEnv,
  )
  assert(
    typeof first.session_id === 'string' && first.session_id.length > 0,
    `Claude create returned no session_id: ${JSON.stringify(first)}`,
  )
  assert(
    first.type === 'result' &&
      !first.is_error &&
      first.result === 'FIRST_ANSWER',
    `Claude create failed or returned unexpected fixture answer: ${JSON.stringify(first)}`,
  )
  const sessionId = first.session_id

  mode = 'claude-turn-2'
  const second = await runClaude(
    referenceBinary,
    [...claudeCommon, '--resume', sessionId, 'SECOND_PROMPT'],
    canonicalCwd,
    configRoot,
    claudeEnv,
  )
  assert(
    second.session_id === sessionId,
    `Claude changed session id to ${second.session_id}`,
  )
  assert(
    second.type === 'result' &&
      !second.is_error &&
      second.result === 'SECOND_ANSWER',
    `Claude resume failed or returned unexpected fixture answer: ${JSON.stringify(second)}`,
  )

  mode = 'claude-turn-3'
  const abandoned = await runClaude(
    referenceBinary,
    [...claudeCommon, '--resume', sessionId, 'ABANDONED_PROMPT'],
    canonicalCwd,
    configRoot,
    claudeEnv,
  )
  assert(
    abandoned.session_id === sessionId,
    `Claude changed session id to ${abandoned.session_id}`,
  )
  assert(
    abandoned.type === 'result' &&
      !abandoned.is_error &&
      abandoned.result === 'ABANDONED_ANSWER',
    `Claude resume failed or returned unexpected fixture answer: ${JSON.stringify(abandoned)}`,
  )

  const sessionPaths = resolveClaudePaths({
    configDir: configRoot,
    cwd: canonicalCwd,
    sessionId,
  })
  const setupEntries = await entries(sessionPaths.sessionFile)
  const secondPrompt = messageEntry(setupEntries, 'SECOND_PROMPT')
  const abandonedPrompt = messageEntry(setupEntries, 'ABANDONED_PROMPT')
  const abandonedAnswer = setupEntries.find(
    (entry) =>
      entry.type === 'assistant' && entry.parentUuid === abandonedPrompt.uuid,
  )
  assert(
    typeof abandonedAnswer?.uuid === 'string',
    'Abandoned assistant entry missing',
  )

  mode = 'praxis-branch'
  const praxisBranch = await praxis(
    '-p',
    '--output-format=json',
    '--resume',
    sessionId,
    '--resume-session-at',
    secondPrompt.uuid,
    '--',
    'PRAXIS_BRANCH_PROMPT',
  )
  const praxisBranchResult = JSON.parse(praxisBranch.stdout)
  assert(
    praxisBranchResult.type === 'result' &&
      !praxisBranchResult.is_error &&
      praxisBranchResult.result === 'PRAXIS_BRANCH_ANSWER',
    `Praxis resume-at failed: ${praxisBranch.stdout}`,
  )
  assertBranchContext('praxis-branch', 'PRAXIS_BRANCH_PROMPT')

  mode = 'claude-branch-resume'
  const cross = await runClaude(
    crossBinary,
    [...claudeCommon, '--resume', sessionId, 'CROSS_BRANCH_PROMPT'],
    canonicalCwd,
    configRoot,
    claudeEnv,
  )
  assert(
    cross.session_id === sessionId,
    `Cross-version Claude changed session id to ${cross.session_id}`,
  )
  assert(
    cross.type === 'result' &&
      !cross.is_error &&
      cross.result === 'CROSS_BRANCH_ANSWER',
    `Cross-version Claude failed or returned unexpected fixture answer: ${JSON.stringify(cross)}`,
  )
  assertBranchContext('claude-branch-resume', 'CROSS_BRANCH_PROMPT')
  const crossSource = requestFor('claude-branch-resume')
  assert(
    crossSource.includes('PRAXIS_BRANCH_PROMPT'),
    'Cross-version resume omitted Praxis branch prompt',
  )
  assert(
    crossSource.includes('PRAXIS_BRANCH_ANSWER'),
    'Cross-version resume omitted Praxis branch answer',
  )

  mode = 'praxis-final'
  const praxisFinal = await praxis(
    '-p',
    '--output-format=json',
    '--resume',
    sessionId,
    '--',
    'PRAXIS_FINAL_PROMPT',
  )
  const praxisFinalResult = JSON.parse(praxisFinal.stdout)
  assert(
    praxisFinalResult.type === 'result' &&
      !praxisFinalResult.is_error &&
      praxisFinalResult.result === 'PRAXIS_FINAL_ANSWER',
    `Praxis final resume failed: ${praxisFinal.stdout}`,
  )
  const finalSource = requestFor('praxis-final')
  assert(
    finalSource.includes('CROSS_BRANCH_PROMPT'),
    'Praxis final resume omitted cross-version prompt',
  )
  assert(
    finalSource.includes('CROSS_BRANCH_ANSWER'),
    'Praxis final resume omitted cross-version answer',
  )
  assert(
    finalSource.includes('PRAXIS_BRANCH_ANSWER'),
    'Praxis final resume omitted Praxis branch answer',
  )
  for (const marker of [
    'SECOND_ANSWER',
    'ABANDONED_PROMPT',
    'ABANDONED_ANSWER',
  ]) {
    assert(
      !finalSource.includes(marker),
      `Praxis final resume retained ${marker}`,
    )
  }

  const expectedTurns = [
    ['claude-turn-1', 'FIRST_PROMPT'],
    ['claude-turn-2', 'SECOND_PROMPT'],
    ['claude-turn-3', 'ABANDONED_PROMPT'],
    ['praxis-branch', 'PRAXIS_BRANCH_PROMPT'],
    ['claude-branch-resume', 'CROSS_BRANCH_PROMPT'],
    ['praxis-final', 'PRAXIS_FINAL_PROMPT'],
  ]
  assert(
    malformed.length === 0,
    `Malformed provider traffic: ${malformed.join('; ')}`,
  )
  assert(
    requests.length === expectedTurns.length,
    `Expected ${expectedTurns.length} provider requests, got ${requests.length}`,
  )
  for (let index = 0; index < expectedTurns.length; index += 1) {
    const [expectedMode, prompt] = expectedTurns[index]
    const request = requests[index]
    assert(
      request.mode === expectedMode,
      `Provider request ${index + 1} was ${request.mode}, expected ${expectedMode}`,
    )
    const source = JSON.stringify(request.body.messages ?? [])
    assert(
      source.includes(prompt),
      `Provider request ${index + 1} (${expectedMode}) omitted ${prompt}`,
    )
  }

  const sessionDir = dirname(sessionPaths.sessionFile)
  const sessionFiles = (await readdir(sessionDir)).filter((name) =>
    name.endsWith('.jsonl'),
  )
  assert(
    sessionFiles.length === 1,
    `Expected exactly one session file, found: ${sessionFiles.join(', ')}`,
  )
  const transcript = await entries(sessionPaths.sessionFile)
  const branch = messageEntry(transcript, 'PRAXIS_BRANCH_PROMPT')
  assert(
    branch.parentUuid === secondPrompt.uuid,
    `Praxis branch parent ${branch.parentUuid} differs from SECOND_PROMPT ${secondPrompt.uuid}`,
  )
  assert(
    transcript.some((entry) => entry.uuid === abandonedPrompt.uuid) &&
      transcript.some((entry) => entry.uuid === abandonedAnswer.uuid),
    'Resume-at rewrote abandoned append-only history',
  )
  const expectedVersions = [
    REFERENCE_VERSION,
    REFERENCE_VERSION,
    REFERENCE_VERSION,
    REFERENCE_VERSION,
    crossVersion,
    REFERENCE_VERSION,
  ]
  const promptSequence = [
    'FIRST_PROMPT',
    'SECOND_PROMPT',
    'ABANDONED_PROMPT',
    'PRAXIS_BRANCH_PROMPT',
    'CROSS_BRANCH_PROMPT',
    'PRAXIS_FINAL_PROMPT',
  ]
  let lastIndex = -1
  for (let index = 0; index < promptSequence.length; index += 1) {
    const prompt = promptSequence[index]
    const entryIndex = transcript.findIndex(
      (candidate) =>
        candidate.type === 'user' && candidate.message?.content === prompt,
    )
    assert(
      entryIndex > lastIndex,
      `Transcript user entry ${prompt} missing or out of order`,
    )
    lastIndex = entryIndex
    assert(
      transcript[entryIndex].sessionId === sessionId,
      `User entry ${prompt} has session id ${transcript[entryIndex].sessionId}, expected ${sessionId}`,
    )
    assert(
      transcript[entryIndex].version === expectedVersions[index],
      `User entry ${prompt} has version ${transcript[entryIndex].version}, expected ${expectedVersions[index]}`,
    )
  }

  console.log(
    `cross-version resume-at compatibility passed: Claude ${REFERENCE_VERSION} produced an append-only branch via Praxis --resume-session-at, then Claude ${crossVersion} and Praxis resumed the branch context of one shared JSONL session (${sessionId}) with producer versions [${expectedVersions.join(', ')}].`,
  )
} finally {
  if (server.listening) await closeServer()
  await rm(root, { recursive: true, force: true })
}
