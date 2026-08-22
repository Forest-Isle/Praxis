import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
if (referenceBinary === crossBinary) {
  throw new Error(
    'PRAXIS_CLAUDE_BINARY and PRAXIS_CLAUDE_CROSS_VERSION_BINARY must be distinct executables',
  )
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function parseJsonLines(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
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
  ['FORK_ROOT_PROMPT', 'FORK_ROOT_ANSWER'],
  ['FORK_SOURCE_FOLLOWUP', 'FORK_SOURCE_FOLLOWUP_ANSWER'],
  ['FORK_CROSS_PROMPT', 'FORK_CROSS_ANSWER'],
  ['FORK_PRAXIS_AFTER_CROSS', 'FORK_PRAXIS_AFTER_CROSS_ANSWER'],
  ['REVERSE_FORK_CROSS_CREATE', 'REVERSE_FORK_CROSS_CREATE_ANSWER'],
  ['REVERSE_FORK_REFERENCE_RESUME', 'REVERSE_FORK_REFERENCE_RESUME_ANSWER'],
  ['REVERSE_FORK_PRAXIS_RESUME', 'REVERSE_FORK_PRAXIS_RESUME_ANSWER'],
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
        id: `msg_cross_version_fork_${randomUUID().replaceAll('-', '')}`,
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

// The cross-version Claude nondeterministically writes one of two native seed
// layouts when it creates a session: a last-prompt-only seed (the seed prompt
// is recorded as a `last-prompt` entry with no initial `user` entry) or an
// initial `user` entry carrying the seed prompt at the cross version. A fork
// child inherits whichever layout the source used. This helper accepts exactly
// those two shapes, rejects every other layout, and returns the user entries
// that follow the seed (the reference/Praxis continuation turns).
function splitReverseSeedUsers(entries, seedPrompt, crossVersion) {
  const userEntries = entries.filter((entry) => entry.type === 'user')
  const seedUserEntries = userEntries.filter(
    (entry) => entry.message?.content === seedPrompt,
  )
  const firstAssistantIndex = entries.findIndex(
    (entry) => entry.type === 'assistant',
  )
  assert(
    firstAssistantIndex !== -1 &&
      entries[firstAssistantIndex]?.version === crossVersion,
    `Cross-version seed create did not produce an assistant entry at version ${crossVersion}, got ${JSON.stringify(entries[firstAssistantIndex] ?? null)}`,
  )
  if (seedUserEntries.length === 0) {
    const seedPromptEntry = entries.find(
      (entry) =>
        entry.type === 'last-prompt' && entry.lastPrompt === seedPrompt,
    )
    assert(
      seedPromptEntry !== undefined,
      `Cross-version seed prompt ${seedPrompt} missing from last-prompt entries`,
    )
    const seedIndex = entries.indexOf(seedPromptEntry)
    const firstUserIndex = entries.findIndex((entry) => entry.type === 'user')
    assert(
      seedIndex !== -1 && (firstUserIndex === -1 || seedIndex < firstUserIndex),
      'Cross-version seed prompt must be recorded before the first resume user entry',
    )
    return { postSeedUsers: userEntries, hasSeedUser: false }
  }
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
  return { postSeedUsers: userEntries.slice(1), hasSeedUser: true }
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

const root = await mkdtemp(join(tmpdir(), 'praxis-cross-version-fork-'))
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
    'Cross-version fork fixture server has no TCP address',
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

  mode = 'fork-root-create'
  const rootTurn = await runClaude(
    referenceBinary,
    [...claudeCommon, 'FORK_ROOT_PROMPT'],
    canonicalCwd,
    configRoot,
    claudeEnv,
  )
  assert(
    typeof rootTurn.session_id === 'string' && rootTurn.session_id.length > 0,
    `Claude create returned no session_id: ${JSON.stringify(rootTurn)}`,
  )
  assert(
    rootTurn.type === 'result' &&
      !rootTurn.is_error &&
      rootTurn.result === 'FORK_ROOT_ANSWER',
    `Claude create failed or returned unexpected fixture answer: ${JSON.stringify(rootTurn)}`,
  )
  const sourceSessionId = rootTurn.session_id

  mode = 'fork-source-followup'
  const followupTurn = await runClaude(
    referenceBinary,
    [...claudeCommon, '--resume', sourceSessionId, 'FORK_SOURCE_FOLLOWUP'],
    canonicalCwd,
    configRoot,
    claudeEnv,
  )
  assert(
    followupTurn.session_id === sourceSessionId,
    `Claude resume changed source session id to ${followupTurn.session_id}`,
  )
  assert(
    followupTurn.type === 'result' &&
      !followupTurn.is_error &&
      followupTurn.result === 'FORK_SOURCE_FOLLOWUP_ANSWER',
    `Claude resume failed or returned unexpected fixture answer: ${JSON.stringify(followupTurn)}`,
  )

  const sourcePaths = resolveClaudePaths({
    configDir: configRoot,
    cwd: canonicalCwd,
    sessionId: sourceSessionId,
  })
  const preForkSourceText = await readFile(sourcePaths.sessionFile, 'utf8')
  const preForkUserSnapshot = parseJsonLines(preForkSourceText)
    .filter((entry) => entry.type === 'user')
    .map((entry) => [entry.message?.content, entry.version, entry.sessionId])
  assert(
    preForkUserSnapshot.length === 2,
    `Expected two pre-fork source user entries, got ${preForkUserSnapshot.length}`,
  )

  const forkStartRequestCount = requests.length
  mode = 'fork-operation'
  const forkRun = await praxis(
    configRoot,
    canonicalCwd,
    'fork',
    '--json',
    sourceSessionId,
  )
  assert(
    requests.length === forkStartRequestCount,
    'fork operation contacted the provider',
  )
  const forkEvent = parseJsonLines(forkRun.stdout).findLast(
    (entry) => entry?.type === 'forked',
  )
  assert(forkEvent, `Praxis fork returned no forked event: ${forkRun.stdout}`)
  assert(
    typeof forkEvent.sessionId === 'string' && forkEvent.sessionId.length > 0,
    `Praxis fork returned no fork session id: ${JSON.stringify(forkEvent)}`,
  )
  assert(
    forkEvent.sessionId !== sourceSessionId,
    `Praxis fork reused the source session id ${sourceSessionId}`,
  )
  assert(
    forkEvent.parentSessionId === sourceSessionId,
    `Praxis fork parent is ${forkEvent.parentSessionId}, expected ${sourceSessionId}`,
  )
  const forkSessionId = forkEvent.sessionId

  mode = 'fork-cross-resume'
  const crossTurn = await runClaude(
    crossBinary,
    [...claudeCommon, '--resume', forkSessionId, 'FORK_CROSS_PROMPT'],
    canonicalCwd,
    configRoot,
    claudeEnv,
  )
  assert(
    crossTurn.session_id === forkSessionId,
    `Cross-version Claude changed fork session id to ${crossTurn.session_id}`,
  )
  assert(
    crossTurn.type === 'result' &&
      !crossTurn.is_error &&
      crossTurn.result === 'FORK_CROSS_ANSWER',
    `Cross-version Claude failed or returned unexpected fixture answer: ${JSON.stringify(crossTurn)}`,
  )

  mode = 'fork-praxis-resume'
  const praxisTurn = await praxis(
    configRoot,
    canonicalCwd,
    '-p',
    '--output-format=json',
    '--resume',
    forkSessionId,
    '--',
    'FORK_PRAXIS_AFTER_CROSS',
  )
  const praxisResult = JSON.parse(praxisTurn.stdout)
  assert(
    praxisResult.type === 'result' &&
      !praxisResult.is_error &&
      praxisResult.result === 'FORK_PRAXIS_AFTER_CROSS_ANSWER',
    `Praxis fork resume failed: ${praxisTurn.stdout}`,
  )

  const expectedTurns = [
    ['fork-root-create', 'FORK_ROOT_PROMPT'],
    ['fork-source-followup', 'FORK_SOURCE_FOLLOWUP'],
    ['fork-cross-resume', 'FORK_CROSS_PROMPT'],
    ['fork-praxis-resume', 'FORK_PRAXIS_AFTER_CROSS'],
  ]
  const requiredMarkers = [
    ['FORK_ROOT_PROMPT'],
    ['FORK_ROOT_PROMPT', 'FORK_SOURCE_FOLLOWUP'],
    ['FORK_ROOT_PROMPT', 'FORK_SOURCE_FOLLOWUP', 'FORK_CROSS_PROMPT'],
    [
      'FORK_ROOT_PROMPT',
      'FORK_SOURCE_FOLLOWUP',
      'FORK_CROSS_PROMPT',
      'FORK_PRAXIS_AFTER_CROSS',
    ],
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
    for (const marker of requiredMarkers[index]) {
      assert(
        source.includes(marker),
        `Provider request ${index + 1} (${expectedMode}) omitted ${marker}`,
      )
    }
  }

  const forkPaths = resolveClaudePaths({
    configDir: configRoot,
    cwd: canonicalCwd,
    sessionId: forkSessionId,
  })
  const finalSourceText = await readFile(sourcePaths.sessionFile, 'utf8')
  const forkText = await readFile(forkPaths.sessionFile, 'utf8')
  assert(
    finalSourceText === preForkSourceText,
    'fork operation changed the source session transcript',
  )
  for (const marker of ['FORK_CROSS_PROMPT', 'FORK_PRAXIS_AFTER_CROSS']) {
    assert(
      !finalSourceText.includes(marker),
      `source session contains fork-only prompt marker ${marker}`,
    )
  }

  const finalSourceUserSnapshot = parseJsonLines(finalSourceText)
    .filter((entry) => entry.type === 'user')
    .map((entry) => [entry.message?.content, entry.version, entry.sessionId])
  assert(
    JSON.stringify(finalSourceUserSnapshot) ===
      JSON.stringify(preForkUserSnapshot),
    'source user-entry versions or session id changed after the fork',
  )

  const forkEntries = parseJsonLines(forkText)
  for (const entry of forkEntries) {
    assert(
      entry.sessionId === forkSessionId ||
        entry.type === 'file-history-snapshot' ||
        entry.type === 'file-history-delta',
      `fork entry ${entry.type} has session id ${entry.sessionId}, expected ${forkSessionId}`,
    )
  }
  const forkPromptSequence = [
    'FORK_ROOT_PROMPT',
    'FORK_SOURCE_FOLLOWUP',
    'FORK_CROSS_PROMPT',
    'FORK_PRAXIS_AFTER_CROSS',
  ]
  const expectedForkVersions = [
    REFERENCE_VERSION,
    REFERENCE_VERSION,
    crossVersion,
    REFERENCE_VERSION,
  ]
  let lastIndex = -1
  for (let index = 0; index < forkPromptSequence.length; index += 1) {
    const prompt = forkPromptSequence[index]
    const entryIndex = forkEntries.findIndex(
      (candidate) =>
        candidate.type === 'user' && candidate.message?.content === prompt,
    )
    assert(
      entryIndex > lastIndex,
      `Fork user entry ${prompt} missing or out of order`,
    )
    lastIndex = entryIndex
    assert(
      forkEntries[entryIndex].sessionId === forkSessionId,
      `Fork user entry ${prompt} has session id ${forkEntries[entryIndex].sessionId}, expected ${forkSessionId}`,
    )
    assert(
      forkEntries[entryIndex].version === expectedForkVersions[index],
      `Fork user entry ${prompt} has version ${forkEntries[entryIndex].version}, expected ${expectedForkVersions[index]}`,
    )
  }

  // Reverse direction: the cross-version Claude creates an isolated source
  // session, Praxis forks it provider-free into a different child session id,
  // reference Claude 2.1.208 resumes the child, and Praxis resumes the child.
  // A separate config root and worktree keep the reverse chain fully isolated
  // from the forward chain, and reverse-only markers keep its fixture turns
  // independently observable.
  mode = 'reverse-fork-cross-create'
  const reverseCreateTurn = await runClaude(
    crossBinary,
    [...claudeCommon, 'REVERSE_FORK_CROSS_CREATE'],
    reverseCanonicalCwd,
    reverseConfigRoot,
    claudeEnv,
  )
  assert(
    typeof reverseCreateTurn.session_id === 'string' &&
      reverseCreateTurn.session_id.length > 0,
    `Cross-version create returned no session_id: ${JSON.stringify(reverseCreateTurn)}`,
  )
  assert(
    reverseCreateTurn.type === 'result' &&
      !reverseCreateTurn.is_error &&
      reverseCreateTurn.result === 'REVERSE_FORK_CROSS_CREATE_ANSWER',
    `Cross-version create failed or returned unexpected fixture answer: ${JSON.stringify(reverseCreateTurn)}`,
  )
  const reverseSourceSessionId = reverseCreateTurn.session_id

  const reverseSourcePaths = resolveClaudePaths({
    configDir: reverseConfigRoot,
    cwd: reverseCanonicalCwd,
    sessionId: reverseSourceSessionId,
  })
  const preReverseForkSourceText = await readFile(
    reverseSourcePaths.sessionFile,
    'utf8',
  )
  const reverseSourceSeed = splitReverseSeedUsers(
    parseJsonLines(preReverseForkSourceText),
    'REVERSE_FORK_CROSS_CREATE',
    crossVersion,
  )
  assert(
    reverseSourceSeed.postSeedUsers.length === 0,
    `Reverse source contains post-seed user entries before the fork: ${JSON.stringify(reverseSourceSeed.postSeedUsers.map((entry) => entry.message?.content))}`,
  )

  const reverseForkStartRequestCount = requests.length
  mode = 'reverse-fork-operation'
  const reverseForkRun = await praxis(
    reverseConfigRoot,
    reverseCanonicalCwd,
    'fork',
    '--json',
    reverseSourceSessionId,
  )
  assert(
    requests.length === reverseForkStartRequestCount,
    'reverse fork operation contacted the provider',
  )
  const reverseForkEvent = parseJsonLines(reverseForkRun.stdout).findLast(
    (entry) => entry?.type === 'forked',
  )
  assert(
    reverseForkEvent,
    `Praxis reverse fork returned no forked event: ${reverseForkRun.stdout}`,
  )
  assert(
    typeof reverseForkEvent.sessionId === 'string' &&
      reverseForkEvent.sessionId.length > 0,
    `Praxis reverse fork returned no fork session id: ${JSON.stringify(reverseForkEvent)}`,
  )
  assert(
    reverseForkEvent.sessionId !== reverseSourceSessionId,
    `Praxis reverse fork reused the source session id ${reverseSourceSessionId}`,
  )
  assert(
    reverseForkEvent.parentSessionId === reverseSourceSessionId,
    `Praxis reverse fork parent is ${reverseForkEvent.parentSessionId}, expected ${reverseSourceSessionId}`,
  )
  const reverseForkSessionId = reverseForkEvent.sessionId

  mode = 'reverse-fork-reference-resume'
  const reverseReferenceTurn = await runClaude(
    referenceBinary,
    [
      ...claudeCommon,
      '--resume',
      reverseForkSessionId,
      'REVERSE_FORK_REFERENCE_RESUME',
    ],
    reverseCanonicalCwd,
    reverseConfigRoot,
    claudeEnv,
  )
  assert(
    reverseReferenceTurn.session_id === reverseForkSessionId,
    `Reference Claude changed reverse fork session id to ${reverseReferenceTurn.session_id}`,
  )
  assert(
    reverseReferenceTurn.type === 'result' &&
      !reverseReferenceTurn.is_error &&
      reverseReferenceTurn.result === 'REVERSE_FORK_REFERENCE_RESUME_ANSWER',
    `Reference Claude failed or returned unexpected fixture answer: ${JSON.stringify(reverseReferenceTurn)}`,
  )

  mode = 'reverse-fork-praxis-resume'
  const reversePraxisTurn = await praxis(
    reverseConfigRoot,
    reverseCanonicalCwd,
    '-p',
    '--output-format=json',
    '--resume',
    reverseForkSessionId,
    '--',
    'REVERSE_FORK_PRAXIS_RESUME',
  )
  const reversePraxisResult = JSON.parse(reversePraxisTurn.stdout)
  assert(
    reversePraxisResult.type === 'result' &&
      !reversePraxisResult.is_error &&
      reversePraxisResult.result === 'REVERSE_FORK_PRAXIS_RESUME_ANSWER',
    `Praxis reverse fork resume failed: ${reversePraxisTurn.stdout}`,
  )

  const reverseExpectedTurns = [
    ['reverse-fork-cross-create', 'REVERSE_FORK_CROSS_CREATE'],
    ['reverse-fork-reference-resume', 'REVERSE_FORK_REFERENCE_RESUME'],
    ['reverse-fork-praxis-resume', 'REVERSE_FORK_PRAXIS_RESUME'],
  ]
  const reverseRequiredMarkers = [
    ['REVERSE_FORK_CROSS_CREATE'],
    ['REVERSE_FORK_CROSS_CREATE', 'REVERSE_FORK_REFERENCE_RESUME'],
    [
      'REVERSE_FORK_CROSS_CREATE',
      'REVERSE_FORK_REFERENCE_RESUME',
      'REVERSE_FORK_PRAXIS_RESUME',
    ],
  ]
  const reverseRequestStart = expectedTurns.length
  const reverseRequests = requests.slice(reverseRequestStart)
  assert(
    reverseRequests.length === reverseExpectedTurns.length,
    `Expected ${reverseExpectedTurns.length} reverse provider requests, got ${reverseRequests.length}`,
  )
  for (let index = 0; index < reverseExpectedTurns.length; index += 1) {
    const [expectedMode, prompt] = reverseExpectedTurns[index]
    const request = reverseRequests[index]
    assert(
      request.mode === expectedMode,
      `Reverse provider request ${index + 1} was ${request.mode}, expected ${expectedMode}`,
    )
    const source = JSON.stringify(request.body.messages ?? [])
    assert(
      source.includes(prompt),
      `Reverse provider request ${index + 1} (${expectedMode}) omitted ${prompt}`,
    )
    for (const marker of reverseRequiredMarkers[index]) {
      assert(
        source.includes(marker),
        `Reverse provider request ${index + 1} (${expectedMode}) omitted ${marker}`,
      )
    }
  }

  const reverseForkPaths = resolveClaudePaths({
    configDir: reverseConfigRoot,
    cwd: reverseCanonicalCwd,
    sessionId: reverseForkSessionId,
  })
  const postReverseForkSourceText = await readFile(
    reverseSourcePaths.sessionFile,
    'utf8',
  )
  const reverseForkText = await readFile(reverseForkPaths.sessionFile, 'utf8')
  assert(
    postReverseForkSourceText === preReverseForkSourceText,
    'reverse fork operation changed the source session transcript',
  )
  for (const marker of [
    'REVERSE_FORK_REFERENCE_RESUME',
    'REVERSE_FORK_PRAXIS_RESUME',
  ]) {
    assert(
      !postReverseForkSourceText.includes(marker),
      `reverse source session contains fork-only prompt marker ${marker}`,
    )
  }

  const reverseForkEntries = parseJsonLines(reverseForkText)
  for (const entry of reverseForkEntries) {
    assert(
      entry.sessionId === reverseForkSessionId ||
        entry.type === 'file-history-snapshot' ||
        entry.type === 'file-history-delta',
      `reverse fork entry ${entry.type} has session id ${entry.sessionId}, expected ${reverseForkSessionId}`,
    )
  }
  const reverseChildSeed = splitReverseSeedUsers(
    reverseForkEntries,
    'REVERSE_FORK_CROSS_CREATE',
    crossVersion,
  )
  const reverseContinuationTurns = [
    ['REVERSE_FORK_REFERENCE_RESUME', referenceVersion],
    ['REVERSE_FORK_PRAXIS_RESUME', referenceVersion],
  ]
  assert(
    reverseChildSeed.postSeedUsers.length === reverseContinuationTurns.length,
    `Expected ${reverseContinuationTurns.length} reverse post-seed user entries, found ${reverseChildSeed.postSeedUsers.length}`,
  )
  for (let index = 0; index < reverseContinuationTurns.length; index += 1) {
    const [prompt, expectedVersion] = reverseContinuationTurns[index]
    const entry = reverseChildSeed.postSeedUsers[index]
    assert(
      entry.message?.content === prompt,
      `Reverse user entry ${index + 1} is ${JSON.stringify(entry.message?.content)}, expected ${prompt}`,
    )
    assert(
      entry.version === expectedVersion,
      `Reverse user entry ${prompt} has version ${entry.version}, expected ${expectedVersion}`,
    )
    assert(
      entry.sessionId === reverseForkSessionId,
      `Reverse user entry ${prompt} has session id ${entry.sessionId}, expected ${reverseForkSessionId}`,
    )
  }
  const reverseVersions = [
    ...(reverseChildSeed.hasSeedUser ? [crossVersion] : []),
    ...reverseChildSeed.postSeedUsers.map((entry) => entry.version),
  ]

  console.log(
    `cross-version fork compatibility passed: Claude ${REFERENCE_VERSION} created source ${sourceSessionId}, Praxis forked it provider-free to ${forkSessionId} (parent ${sourceSessionId}), Claude ${crossVersion} and Praxis resumed the fork with producer versions [${expectedForkVersions.join(', ')}].`,
  )
  console.log(
    `reverse cross-version fork compatibility passed: Claude ${crossVersion} created source ${reverseSourceSessionId}, Praxis forked it provider-free to ${reverseForkSessionId} (parent ${reverseSourceSessionId}), Claude ${REFERENCE_VERSION} and Praxis resumed the fork with producer versions [${reverseVersions.join(', ')}].`,
  )
} finally {
  if (server.listening) await closeServer()
  await rm(root, { recursive: true, force: true })
}
