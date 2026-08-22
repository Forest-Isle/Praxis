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
const CROSS_VERSION = '2.1.233'
const referenceBinary = process.env.PRAXIS_CLAUDE_BINARY
const crossBinary = process.env.PRAXIS_CLAUDE_CROSS_VERSION_BINARY

if (!referenceBinary) {
  throw new Error(
    'PRAXIS_CLAUDE_BINARY must point to the Claude Code 2.1.208 executable',
  )
}
if (!crossBinary) {
  throw new Error(
    `PRAXIS_CLAUDE_CROSS_VERSION_BINARY must point to the Claude Code ${CROSS_VERSION} executable`,
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
  ['FROM_21208', 'FROM_21208_ANSWER'],
  ['FROM_PRAXIS', 'FROM_PRAXIS_ANSWER'],
  ['FROM_CROSS_VERSION', 'FROM_CROSS_VERSION_ANSWER'],
  ['FROM_PRAXIS_AFTER_CROSS_VERSION', 'FROM_PRAXIS_AFTER_CROSS_VERSION_ANSWER'],
  ['REVERSE_CROSS_FIRST', 'REVERSE_CROSS_FIRST_ANSWER'],
  ['REVERSE_PRAXIS_SECOND', 'REVERSE_PRAXIS_SECOND_ANSWER'],
  ['REVERSE_21208_THIRD', 'REVERSE_21208_THIRD_ANSWER'],
  ['REVERSE_PRAXIS_FOURTH', 'REVERSE_PRAXIS_FOURTH_ANSWER'],
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

async function assertTranscriptProducerSequence({
  configRoot,
  cwd,
  sessionId,
  promptSequence,
  expectedVersions,
}) {
  const sessionPaths = resolveClaudePaths({
    configDir: configRoot,
    cwd,
    sessionId,
  })
  const sessionDir = dirname(sessionPaths.sessionFile)
  const sessionFiles = (await readdir(sessionDir)).filter((name) =>
    name.endsWith('.jsonl'),
  )
  assert(
    sessionFiles.length === 1,
    `Expected exactly one session file, found: ${sessionFiles.join(', ')}`,
  )
  const transcriptSource = await readFile(sessionPaths.sessionFile, 'utf8')
  const transcript = transcriptSource
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
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
      transcript[entryIndex].version === expectedVersions[index],
      `User entry ${prompt} has version ${transcript[entryIndex].version}, expected ${expectedVersions[index]}`,
    )
  }
}

// The cross-version Claude nondeterministically writes one of two native seed
// layouts when it creates a session: a last-prompt-only seed (the seed prompt
// is recorded as a `last-prompt` entry with no initial `user` entry) or an
// initial `user` entry carrying the seed prompt at the cross version. In both
// layouts the message chain starts with its own assistant response. This
// helper asserts the exact producer shape and the per-turn producer versions
// it records: [<cross version>, 2.1.208, 2.1.208, 2.1.208].
async function assertReverseCrossFirstTranscript({
  configRoot,
  cwd,
  sessionId,
  crossVersion,
  referenceVersion,
}) {
  const sessionPaths = resolveClaudePaths({
    configDir: configRoot,
    cwd,
    sessionId,
  })
  const sessionDir = dirname(sessionPaths.sessionFile)
  const sessionFiles = (await readdir(sessionDir)).filter((name) =>
    name.endsWith('.jsonl'),
  )
  assert(
    sessionFiles.length === 1,
    `Expected exactly one session file, found: ${sessionFiles.join(', ')}`,
  )
  const transcriptSource = await readFile(sessionPaths.sessionFile, 'utf8')
  const transcript = transcriptSource
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))

  const seedPromptEntry = transcript.find(
    (entry) =>
      entry.type === 'last-prompt' &&
      entry.lastPrompt === 'REVERSE_CROSS_FIRST',
  )
  const userEntries = transcript.filter((entry) => entry.type === 'user')
  const seedUserEntries = userEntries.filter(
    (entry) => entry.message?.content === 'REVERSE_CROSS_FIRST',
  )

  const firstAssistantIndex = transcript.findIndex(
    (entry) => entry.type === 'assistant',
  )
  assert(
    firstAssistantIndex !== -1 &&
      transcript[firstAssistantIndex]?.version === crossVersion,
    `Cross-version create did not produce an assistant entry at version ${crossVersion}, got ${JSON.stringify(transcript[firstAssistantIndex] ?? null)}`,
  )

  // The cross-version Claude nondeterministically writes one of two native
  // seed layouts: a last-prompt-only seed (no initial user entry) or an
  // initial user entry carrying the seed prompt at the cross version.
  let resumeUserEntries
  if (seedUserEntries.length === 0) {
    assert(
      seedPromptEntry !== undefined,
      'Cross-version seed prompt REVERSE_CROSS_FIRST missing from last-prompt entries',
    )
    const seedIndex = transcript.indexOf(seedPromptEntry)
    const firstUserIndex = transcript.findIndex(
      (entry) => entry.type === 'user',
    )
    assert(
      seedIndex !== -1 && firstUserIndex !== -1 && seedIndex < firstUserIndex,
      'Cross-version seed prompt must be recorded before the first resume user entry',
    )
    resumeUserEntries = userEntries
  } else {
    assert(
      seedUserEntries.length === 1,
      `Expected exactly one initial user seed entry, found ${seedUserEntries.length}`,
    )
    assert(
      userEntries[0] === seedUserEntries[0],
      'Cross-version initial user seed entry must be the first user entry, before the resume user turns',
    )
    assert(
      seedUserEntries[0].version === crossVersion,
      `Cross-version seed user entry has version ${seedUserEntries[0].version}, expected ${crossVersion}`,
    )
    resumeUserEntries = userEntries.slice(1)
  }

  const expectedUserTurns = [
    ['REVERSE_PRAXIS_SECOND', referenceVersion],
    ['REVERSE_21208_THIRD', referenceVersion],
    ['REVERSE_PRAXIS_FOURTH', referenceVersion],
  ]
  assert(
    resumeUserEntries.length === expectedUserTurns.length,
    `Expected ${expectedUserTurns.length} post-seed user entries, found ${resumeUserEntries.length}`,
  )
  for (let index = 0; index < expectedUserTurns.length; index += 1) {
    const [prompt, expectedVersion] = expectedUserTurns[index]
    assert(
      resumeUserEntries[index].message?.content === prompt,
      `User entry ${index + 1} is ${JSON.stringify(resumeUserEntries[index].message?.content)}, expected ${prompt}`,
    )
    assert(
      resumeUserEntries[index].version === expectedVersion,
      `User entry ${prompt} has version ${resumeUserEntries[index].version}, expected ${expectedVersion}`,
    )
  }
  return [crossVersion, referenceVersion, referenceVersion, referenceVersion]
}

const root = await mkdtemp(join(tmpdir(), 'praxis-cross-version-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'work')
const reverseConfigRoot = join(root, 'reverse-config')
const reverseCwd = join(root, 'reverse-work')

try {
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(configRoot, { recursive: true }),
    mkdir(reverseCwd, { recursive: true }),
    mkdir(reverseConfigRoot, { recursive: true }),
  ])
  const canonicalCwd = await realpath(cwd)
  const reverseCanonicalCwd = await realpath(reverseCwd)

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
    crossVersion === CROSS_VERSION,
    `Cross-version Claude CLI must be ${CROSS_VERSION}, got ${crossVersion}`,
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
    PRAXIS_DATA_PLANE: 'claude',
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
  const praxis = (execConfigRoot, execCwd, ...args) =>
    execFileAsync(
      process.execPath,
      [join(process.cwd(), 'dist/cli.js'), ...args],
      {
        cwd: execCwd,
        env: {
          ...process.env,
          ...praxisEnv,
          CLAUDE_CONFIG_DIR: execConfigRoot,
        },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
      },
    )

  mode = 'claude-turn-1'
  const first = await runClaude(
    referenceBinary,
    [...claudeCommon, 'FROM_21208'],
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
      first.result === 'FROM_21208_ANSWER',
    `Claude create failed or returned unexpected fixture answer: ${JSON.stringify(first)}`,
  )
  const sessionId = first.session_id

  mode = 'praxis-turn-2'
  const praxisTurn2 = await praxis(
    configRoot,
    canonicalCwd,
    '-p',
    '--output-format=json',
    '--resume',
    sessionId,
    '--',
    'FROM_PRAXIS',
  )
  const praxisResult2 = JSON.parse(praxisTurn2.stdout)
  assert(
    praxisResult2.type === 'result' &&
      !praxisResult2.is_error &&
      praxisResult2.result === 'FROM_PRAXIS_ANSWER',
    `Praxis turn 2 failed: ${praxisTurn2.stdout}`,
  )

  mode = 'claude-turn-3'
  const third = await runClaude(
    crossBinary,
    [...claudeCommon, '--resume', sessionId, 'FROM_CROSS_VERSION'],
    canonicalCwd,
    configRoot,
    claudeEnv,
  )
  assert(
    third.session_id === sessionId,
    `Cross-version Claude changed session id to ${third.session_id}`,
  )
  assert(
    third.type === 'result' &&
      !third.is_error &&
      third.result === 'FROM_CROSS_VERSION_ANSWER',
    `Cross-version Claude failed or returned unexpected fixture answer: ${JSON.stringify(third)}`,
  )

  mode = 'praxis-turn-4'
  const praxisTurn4 = await praxis(
    configRoot,
    canonicalCwd,
    '-p',
    '--output-format=json',
    '--resume',
    sessionId,
    '--',
    'FROM_PRAXIS_AFTER_CROSS_VERSION',
  )
  const praxisResult4 = JSON.parse(praxisTurn4.stdout)
  assert(
    praxisResult4.type === 'result' &&
      !praxisResult4.is_error &&
      praxisResult4.result === 'FROM_PRAXIS_AFTER_CROSS_VERSION_ANSWER',
    `Praxis turn 4 failed: ${praxisTurn4.stdout}`,
  )

  const expectedTurns = [
    ['claude-turn-1', 'FROM_21208'],
    ['praxis-turn-2', 'FROM_PRAXIS'],
    ['claude-turn-3', 'FROM_CROSS_VERSION'],
    ['praxis-turn-4', 'FROM_PRAXIS_AFTER_CROSS_VERSION'],
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

  const expectedVersions = [
    REFERENCE_VERSION,
    REFERENCE_VERSION,
    crossVersion,
    REFERENCE_VERSION,
  ]
  const promptSequence = [
    'FROM_21208',
    'FROM_PRAXIS',
    'FROM_CROSS_VERSION',
    'FROM_PRAXIS_AFTER_CROSS_VERSION',
  ]
  await assertTranscriptProducerSequence({
    configRoot,
    cwd: canonicalCwd,
    sessionId,
    promptSequence,
    expectedVersions,
  })

  console.log(
    `cross-version session compatibility passed: Claude ${REFERENCE_VERSION}, Praxis, and Claude ${crossVersion} alternately resumed one shared JSONL session (${sessionId}) with producer versions [${expectedVersions.join(', ')}].`,
  )

  // Reverse cross-first direction: the cross-version Claude creates a second
  // isolated session, Praxis resumes it, reference Claude resumes it, and
  // Praxis resumes it again. Uses an independent config root and worktree so
  // the reverse chain shares no transcript state with the forward chain.
  mode = 'reverse-claude-turn-1'
  const reverseFirst = await runClaude(
    crossBinary,
    [...claudeCommon, 'REVERSE_CROSS_FIRST'],
    reverseCanonicalCwd,
    reverseConfigRoot,
    claudeEnv,
  )
  assert(
    typeof reverseFirst.session_id === 'string' &&
      reverseFirst.session_id.length > 0,
    `Cross-version create returned no session_id: ${JSON.stringify(reverseFirst)}`,
  )
  assert(
    reverseFirst.type === 'result' &&
      !reverseFirst.is_error &&
      reverseFirst.result === 'REVERSE_CROSS_FIRST_ANSWER',
    `Cross-version create failed or returned unexpected fixture answer: ${JSON.stringify(reverseFirst)}`,
  )
  const reverseSessionId = reverseFirst.session_id

  mode = 'reverse-praxis-turn-2'
  const reversePraxis2 = await praxis(
    reverseConfigRoot,
    reverseCanonicalCwd,
    '-p',
    '--output-format=json',
    '--resume',
    reverseSessionId,
    '--',
    'REVERSE_PRAXIS_SECOND',
  )
  const reversePraxisResult2 = JSON.parse(reversePraxis2.stdout)
  assert(
    reversePraxisResult2.type === 'result' &&
      !reversePraxisResult2.is_error &&
      reversePraxisResult2.result === 'REVERSE_PRAXIS_SECOND_ANSWER',
    `Praxis reverse turn 2 failed: ${reversePraxis2.stdout}`,
  )
  assert(
    reversePraxisResult2.session_id === reverseSessionId,
    `Praxis reverse turn 2 changed session id to ${reversePraxisResult2.session_id}`,
  )

  mode = 'reverse-claude-turn-3'
  const reverseThird = await runClaude(
    referenceBinary,
    [...claudeCommon, '--resume', reverseSessionId, 'REVERSE_21208_THIRD'],
    reverseCanonicalCwd,
    reverseConfigRoot,
    claudeEnv,
  )
  assert(
    reverseThird.session_id === reverseSessionId,
    `Reference Claude changed session id to ${reverseThird.session_id}`,
  )
  assert(
    reverseThird.type === 'result' &&
      !reverseThird.is_error &&
      reverseThird.result === 'REVERSE_21208_THIRD_ANSWER',
    `Reference Claude reverse resume failed or returned unexpected fixture answer: ${JSON.stringify(reverseThird)}`,
  )

  mode = 'reverse-praxis-turn-4'
  const reversePraxis4 = await praxis(
    reverseConfigRoot,
    reverseCanonicalCwd,
    '-p',
    '--output-format=json',
    '--resume',
    reverseSessionId,
    '--',
    'REVERSE_PRAXIS_FOURTH',
  )
  const reversePraxisResult4 = JSON.parse(reversePraxis4.stdout)
  assert(
    reversePraxisResult4.type === 'result' &&
      !reversePraxisResult4.is_error &&
      reversePraxisResult4.result === 'REVERSE_PRAXIS_FOURTH_ANSWER',
    `Praxis reverse turn 4 failed: ${reversePraxis4.stdout}`,
  )
  assert(
    reversePraxisResult4.session_id === reverseSessionId,
    `Praxis reverse turn 4 changed session id to ${reversePraxisResult4.session_id}`,
  )

  const reverseExpectedTurns = [
    ['reverse-claude-turn-1', 'REVERSE_CROSS_FIRST'],
    ['reverse-praxis-turn-2', 'REVERSE_PRAXIS_SECOND'],
    ['reverse-claude-turn-3', 'REVERSE_21208_THIRD'],
    ['reverse-praxis-turn-4', 'REVERSE_PRAXIS_FOURTH'],
  ]
  assert(
    malformed.length === 0,
    `Malformed provider traffic: ${malformed.join('; ')}`,
  )
  assert(
    requests.length === expectedTurns.length + reverseExpectedTurns.length,
    `Expected ${expectedTurns.length + reverseExpectedTurns.length} provider requests, got ${requests.length}`,
  )
  for (let index = 0; index < reverseExpectedTurns.length; index += 1) {
    const [expectedMode, prompt] = reverseExpectedTurns[index]
    const request = requests[expectedTurns.length + index]
    assert(
      request.mode === expectedMode,
      `Provider request ${expectedTurns.length + index + 1} was ${request.mode}, expected ${expectedMode}`,
    )
    const source = JSON.stringify(request.body.messages ?? [])
    assert(
      source.includes(prompt),
      `Provider request ${expectedTurns.length + index + 1} (${expectedMode}) omitted ${prompt}`,
    )
  }

  const reverseProducerVersions = await assertReverseCrossFirstTranscript({
    configRoot: reverseConfigRoot,
    cwd: reverseCanonicalCwd,
    sessionId: reverseSessionId,
    crossVersion,
    referenceVersion: REFERENCE_VERSION,
  })

  console.log(
    `reverse cross-first session compatibility passed: Claude ${crossVersion} created, then Praxis and Claude ${REFERENCE_VERSION} alternately resumed one shared JSONL session (${reverseSessionId}) with producer versions [${reverseProducerVersions.join(', ')}].`,
  )
} finally {
  if (server.listening) await closeServer()
  await rm(root, { recursive: true, force: true })
}
