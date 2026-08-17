import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import { parseClaudeVersionOutput } from '../dist/compatibility/claude/schema.js'
import { execFileAsync } from './lib/claude-probe.mjs'

const REFERENCE_VERSION = '2.1.208'
const referenceBinary = process.env.PRAXIS_CLAUDE_BINARY
const crossBinary = process.env.PRAXIS_CLAUDE_CROSS_VERSION_BINARY
const DROPPED = 'CROSS_COMPACT_DROPPED'
const KEEP = 'CROSS_COMPACT_KEEP'
const ORIGIN_PROMPT = 'CROSS_COMPACT_ORIGIN_PROMPT'
const ORIGIN_ANSWER = 'CROSS_COMPACT_ORIGIN'
const CONTINUE_PROMPT = 'CROSS_COMPACT_CONTINUE'
const PRAXIS_AFTER_COMPACT_PROMPT = 'CROSS_COMPACT_PRAXIS_AFTER_COMPACT'
const PRAXIS_AFTER_COMPACT_ANSWER = 'CROSS_COMPACT_PRAXIS_AFTER_COMPACT'
const CLAUDE_PROMPT = 'CROSS_COMPACT_CLAUDE_PROMPT'
const CLAUDE_ANSWER = 'CROSS_COMPACT_CLAUDE_ANSWER'
const FINAL_PROMPT = 'CROSS_COMPACT_PRAXIS_AFTER_CLAUDE'
const FINAL_ANSWER = 'CROSS_COMPACT_PRAXIS_FINAL'

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

function messagesText(body) {
  return JSON.stringify(body.messages ?? [])
}

function bodyText(body) {
  return `${body.system ?? ''}\n${messagesText(body)}`
}

function textEvents(text) {
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_cross_compaction_${randomUUID().replaceAll('-', '')}`,
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
      usage: { input_tokens: 1, output_tokens: 1 },
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
  const serialized = bodyText(body)
  const compacting = serialized.includes(
    'You are compacting an agent conversation',
  )
  const answer = compacting
    ? KEEP
    : serialized.includes(FINAL_PROMPT)
      ? FINAL_ANSWER
      : serialized.includes(CLAUDE_PROMPT)
        ? CLAUDE_ANSWER
        : serialized.includes(PRAXIS_AFTER_COMPACT_PROMPT)
          ? PRAXIS_AFTER_COMPACT_ANSWER
          : serialized.includes(CONTINUE_PROMPT)
            ? PRAXIS_AFTER_COMPACT_ANSWER
            : serialized.includes(ORIGIN_PROMPT)
              ? ORIGIN_ANSWER
              : 'UNEXPECTED_FIXTURE_REQUEST'
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    textEvents(answer)
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
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
  })
  return JSON.parse(stdout)
}

async function runPraxis(
  cli,
  args,
  cwd,
  configRoot,
  providerEnv,
  extraEnv = {},
) {
  const { stdout } = await execFileAsync(process.execPath, [cli, ...args], {
    cwd,
    env: {
      ...process.env,
      ...providerEnv,
      ...extraEnv,
      CLAUDE_CONFIG_DIR: configRoot,
    },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
  })
  return JSON.parse(stdout)
}

const root = await mkdtemp(join(tmpdir(), 'praxis-cross-version-compaction-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'work')

try {
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(configRoot, { recursive: true }),
  ])
  const canonicalCwd = await realpath(cwd)
  const cli = join(process.cwd(), 'dist', 'cli.js')
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
    'Cross-version compaction fixture server has no TCP address',
  )
  const port = address.port
  const claudeEnv = {
    ANTHROPIC_API_KEY: 'fixture-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  }
  const providerEnv = {
    PRAXIS_PROVIDER: 'anthropic',
    PRAXIS_API_KEY: 'fixture-key',
    PRAXIS_MODEL: 'fixture-model',
    PRAXIS_BASE_URL: `http://127.0.0.1:${port}/v1`,
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

  mode = 'praxis-origin'
  const origin = await runPraxis(
    cli,
    [
      '-p',
      '--output-format=json',
      '--',
      `${ORIGIN_PROMPT} ${DROPPED} ${'old-context '.repeat(2500)}`,
    ],
    canonicalCwd,
    configRoot,
    providerEnv,
  )
  assert(
    origin.type === 'result' &&
      !origin.is_error &&
      origin.result === ORIGIN_ANSWER,
    `Praxis origin failed: ${JSON.stringify(origin)}`,
  )
  assert(
    typeof origin.session_id === 'string' ||
      typeof origin.sessionId === 'string',
    `Praxis origin returned no session id: ${JSON.stringify(origin)}`,
  )
  const sessionId = origin.session_id ?? origin.sessionId

  mode = 'praxis-compaction'
  const continued = await runPraxis(
    cli,
    [
      '-p',
      '--output-format=json',
      '--resume',
      sessionId,
      '--',
      CONTINUE_PROMPT,
    ],
    canonicalCwd,
    configRoot,
    providerEnv,
    {
      PRAXIS_CONTEXT_WINDOW_TOKENS: '12000',
      PRAXIS_CONTEXT_RESERVE_TOKENS: '4000',
    },
  )
  assert(
    continued.type === 'result' &&
      !continued.is_error &&
      continued.result === PRAXIS_AFTER_COMPACT_ANSWER,
    `Praxis compaction resume failed: ${JSON.stringify(continued)}`,
  )
  assert(
    (continued.session_id ?? continued.sessionId) === sessionId,
    'Praxis compaction resume changed session id',
  )

  mode = 'claude-cross-version'
  const cross = await runClaude(
    crossBinary,
    [...claudeCommon, '--resume', sessionId, CLAUDE_PROMPT],
    canonicalCwd,
    configRoot,
    claudeEnv,
  )
  assert(
    cross.type === 'result' &&
      !cross.is_error &&
      cross.result === CLAUDE_ANSWER,
    `Cross-version Claude resume failed: ${JSON.stringify(cross)}`,
  )
  assert(
    cross.session_id === sessionId,
    'Cross-version Claude changed session id',
  )

  mode = 'praxis-final'
  const final = await runPraxis(
    cli,
    ['-p', '--output-format=json', '--resume', sessionId, '--', FINAL_PROMPT],
    canonicalCwd,
    configRoot,
    providerEnv,
  )
  assert(
    final.type === 'result' && !final.is_error && final.result === FINAL_ANSWER,
    `Praxis final resume failed: ${JSON.stringify(final)}`,
  )
  assert(
    (final.session_id ?? final.sessionId) === sessionId,
    'Praxis final changed session id',
  )

  assert(
    malformed.length === 0,
    `Malformed provider traffic: ${malformed.join('; ')}`,
  )
  assert(
    requests.length === 5,
    `Expected five provider requests, got ${requests.length}`,
  )
  const expectedRequestModes = [
    'praxis-origin',
    'praxis-compaction',
    'praxis-compaction',
    'claude-cross-version',
    'praxis-final',
  ]
  assert(
    JSON.stringify(requests.map((request) => request.mode)) ===
      JSON.stringify(expectedRequestModes),
    `Provider request order was ${JSON.stringify(
      requests.map((request) => request.mode),
    )}, expected ${JSON.stringify(expectedRequestModes)}`,
  )
  const originText = bodyText(requests[0].body)
  assert(
    originText.includes(ORIGIN_PROMPT) && originText.includes(DROPPED),
    'Origin Praxis request omitted the long compaction-history marker',
  )
  const compactRequest = requests.find((request) =>
    bodyText(request.body).includes('You are compacting an agent conversation'),
  )
  assert(compactRequest, 'Compactor provider request was not observed')
  const compactText = bodyText(compactRequest.body)
  assert(
    compactText.includes(DROPPED),
    'Compactor request omitted original history marker',
  )
  const mainAfterCompact = requests.find(
    (request) =>
      request.mode === 'praxis-compaction' && request !== compactRequest,
  )
  assert(
    mainAfterCompact,
    'Post-compaction Praxis provider request was not observed',
  )
  const mainAfterCompactText = bodyText(mainAfterCompact.body)
  assert(
    mainAfterCompactText.includes(KEEP),
    'Post-compaction Praxis request omitted KEEP',
  )
  assert(
    !mainAfterCompactText.includes(DROPPED),
    'Post-compaction Praxis request retained DROPPED',
  )
  const crossText = bodyText(
    requests.find((request) => request.mode === 'claude-cross-version').body,
  )
  assert(
    crossText.includes(KEEP) && crossText.includes(PRAXIS_AFTER_COMPACT_ANSWER),
    'Cross-version request omitted compacted Praxis context',
  )
  assert(!crossText.includes(DROPPED), 'Cross-version request retained DROPPED')
  const finalText = bodyText(
    requests.find((request) => request.mode === 'praxis-final').body,
  )
  assert(
    finalText.includes(KEEP) &&
      finalText.includes(CLAUDE_PROMPT) &&
      finalText.includes(CLAUDE_ANSWER),
    'Final Praxis request omitted cross-version context',
  )
  assert(!finalText.includes(DROPPED), 'Final Praxis request retained DROPPED')

  const sessionFile = resolveClaudePaths({
    configDir: configRoot,
    cwd: canonicalCwd,
    sessionId,
  }).sessionFile
  const transcriptSource = await readFile(sessionFile, 'utf8')
  const transcript = parseJsonLines(transcriptSource)
  assert(
    transcriptSource.includes(DROPPED),
    'Append-only transcript lost DROPPED',
  )
  assert(
    transcript.some(
      (entry) =>
        entry.type === 'system' && entry.subtype === 'compact_boundary',
    ),
    'Missing compact_boundary entry',
  )
  assert(
    transcript.some(
      (entry) => entry.type === 'user' && entry.isCompactSummary === true,
    ),
    'Missing isCompactSummary entry',
  )
  const promptSequence = [
    ORIGIN_PROMPT,
    CONTINUE_PROMPT,
    CLAUDE_PROMPT,
    FINAL_PROMPT,
  ]
  const versions = [
    REFERENCE_VERSION,
    REFERENCE_VERSION,
    crossVersion,
    REFERENCE_VERSION,
  ]
  let lastIndex = -1
  for (let index = 0; index < promptSequence.length; index += 1) {
    const prompt = promptSequence[index]
    const entryIndex = transcript.findIndex(
      (entry) =>
        entry.type === 'user' &&
        typeof entry.message?.content === 'string' &&
        entry.message.content.includes(prompt),
    )
    assert(
      entryIndex > lastIndex,
      `Transcript user entry ${prompt} missing or out of order`,
    )
    lastIndex = entryIndex
    assert(
      transcript[entryIndex].sessionId === sessionId,
      `Transcript entry ${prompt} changed session id`,
    )
    assert(
      transcript[entryIndex].version === versions[index],
      `Transcript entry ${prompt} has version ${transcript[entryIndex].version}, expected ${versions[index]}`,
    )
  }
  console.log(
    `cross-version compaction compatibility passed: Praxis compacted ${sessionId}, Claude ${crossVersion} resumed the compacted projection, and Praxis resumed it again with producer versions [${versions.join(', ')}].`,
  )
} finally {
  if (server.listening) await closeServer()
  await rm(root, { recursive: true, force: true })
}
