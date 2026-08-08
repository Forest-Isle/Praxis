import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { createClaudeNativeFork } from '../dist/compatibility/claude/fork.js'
import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import { selectClaudeSchemaAdapter } from '../dist/compatibility/claude/schema.js'
import { ClaudeTranscriptStore } from '../dist/persistence/claude-transcript-store.js'
import {
  detectClaudeVersion,
  execFileAsync,
  runClaudeJson,
} from './lib/claude-probe.mjs'

const root = await mkdtemp(join(tmpdir(), 'praxis-resume-at-compat-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'work')
const requests = []
let mode = 'setup'

const markers = [
  ['CLAUDE_ASSISTANT_BRANCH_PROMPT', 'CLAUDE_ASSISTANT_BRANCH_ANSWER'],
  ['PRAXIS_ASSISTANT_BRANCH_PROMPT', 'PRAXIS_ASSISTANT_BRANCH_ANSWER'],
  ['BACKGROUND_BRANCH_PROMPT', 'BACKGROUND_BRANCH_ANSWER'],
  ['CLAUDE_FORK_BRANCH_PROMPT', 'CLAUDE_FORK_BRANCH_ANSWER'],
  ['PRAXIS_FORK_BRANCH_PROMPT', 'PRAXIS_FORK_BRANCH_ANSWER'],
  ['CLAUDE_CROSS_PROMPT', 'CLAUDE_CROSS_ANSWER'],
  ['PRAXIS_CROSS_PROMPT', 'PRAXIS_CROSS_ANSWER'],
  ['BRANCH_PROMPT', 'BRANCH_ANSWER'],
  ['ABANDONED_PROMPT', 'ABANDONED_ANSWER'],
  ['SECOND_PROMPT', 'SECOND_ANSWER'],
  ['FIRST_PROMPT', 'FIRST_ANSWER'],
]

function responseText(body) {
  const source = JSON.stringify(body.messages ?? [])
  return markers.find(([marker]) => source.includes(marker))?.[1] ?? 'ANSWER'
}

function textEvents(text) {
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_resume_at_${randomUUID().replaceAll('-', '')}`,
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
  const body = JSON.parse(source)
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

function assert(condition, message) {
  if (!condition) throw new Error(message)
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

async function waitForRequest(requestMode, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (requests.some((request) => request.mode === requestMode)) return
    await delay(50)
  }
  throw new Error(`Timed out waiting for ${requestMode}`)
}

try {
  const version = await detectClaudeVersion('resume-session-at compatibility')
  const schema = selectClaudeSchemaAdapter(version)
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(configRoot, { recursive: true }),
  ])
  const canonicalCwd = await realpath(cwd)
  await listen()
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Resume-at fixture server has no TCP address')
  }
  const claudeEnv = {
    ANTHROPIC_API_KEY: 'fixture-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
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

  mode = 'claude-setup-first'
  const first = await runClaudeJson(
    [...claudeCommon, 'FIRST_PROMPT'],
    canonicalCwd,
    configRoot,
    claudeEnv,
  )
  mode = 'claude-setup-second'
  await runClaudeJson(
    [...claudeCommon, '--resume', first.session_id, 'SECOND_PROMPT'],
    canonicalCwd,
    configRoot,
    claudeEnv,
  )
  mode = 'claude-setup-abandoned'
  await runClaudeJson(
    [...claudeCommon, '--resume', first.session_id, 'ABANDONED_PROMPT'],
    canonicalCwd,
    configRoot,
    claudeEnv,
  )

  const sourcePaths = resolveClaudePaths({
    configDir: configRoot,
    cwd: canonicalCwd,
    sessionId: first.session_id,
  })
  const sourceEntries = await entries(sourcePaths.sessionFile)
  const target = messageEntry(sourceEntries, 'SECOND_PROMPT')
  const abandoned = messageEntry(sourceEntries, 'ABANDONED_PROMPT')
  const targetAnswer = sourceEntries.find(
    (entry) => entry.type === 'assistant' && entry.parentUuid === target.uuid,
  )
  assert(typeof targetAnswer?.uuid === 'string', 'Target assistant missing')

  async function cloneSession(sessionId) {
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd: canonicalCwd,
      sessionId,
    })
    const store = new ClaudeTranscriptStore({
      sessionFile: paths.sessionFile,
      lockFile: join(paths.praxisRoot, 'locks', `${sessionId}.lock`),
      schema,
    })
    const created = await store.create(
      createClaudeNativeFork({
        source: sourceEntries,
        sourceSessionId: first.session_id,
        sessionId,
      }),
    )
    assert(created.status === 'created', `Could not clone ${sessionId}`)
    return paths
  }

  const praxisSourceId = '61616161-6161-4161-8161-616161616161'
  const praxisPaths = await cloneSession(praxisSourceId)
  mode = 'claude-branch'
  await runClaudeJson(
    [
      ...claudeCommon,
      '--resume',
      first.session_id,
      '--resume-session-at',
      target.uuid,
      'BRANCH_PROMPT',
    ],
    canonicalCwd,
    configRoot,
    claudeEnv,
  )
  mode = 'praxis-branch'
  const praxisBranch = await praxis(
    '-p',
    '--output-format=json',
    '--resume',
    praxisSourceId,
    '--resume-session-at',
    target.uuid,
    '--',
    'BRANCH_PROMPT',
  )
  const praxisBranchResult = JSON.parse(praxisBranch.stdout)
  assert(
    praxisBranchResult.type === 'result' &&
      !praxisBranchResult.is_error &&
      praxisBranchResult.result === 'BRANCH_ANSWER',
    `Praxis resume-at failed: ${praxisBranch.stdout}`,
  )
  assertBranchContext('claude-branch', 'BRANCH_PROMPT')
  assertBranchContext('praxis-branch', 'BRANCH_PROMPT')

  for (const [label, path] of [
    ['Claude', sourcePaths.sessionFile],
    ['Praxis', praxisPaths.sessionFile],
  ]) {
    const transcript = await entries(path)
    const branch = messageEntry(transcript, 'BRANCH_PROMPT')
    assert(branch.parentUuid === target.uuid, `${label} branch parent differs`)
    assert(
      transcript.some((entry) => entry.uuid === abandoned.uuid),
      `${label} rewrote abandoned append-only history`,
    )
    assert(
      transcript.at(-1)?.type === 'last-prompt' &&
        transcript.at(-1)?.lastPrompt === 'BRANCH_PROMPT',
      `${label} last-prompt metadata differs`,
    )
  }

  mode = 'praxis-cross'
  await praxis(
    '-p',
    '--output-format=json',
    '--resume',
    first.session_id,
    '--',
    'PRAXIS_CROSS_PROMPT',
  )
  assertBranchContext('praxis-cross', 'PRAXIS_CROSS_PROMPT')
  assert(
    requestFor('praxis-cross').includes('BRANCH_ANSWER'),
    'Praxis did not resume Claude branch',
  )
  mode = 'claude-cross'
  await runClaudeJson(
    [...claudeCommon, '--resume', praxisSourceId, 'CLAUDE_CROSS_PROMPT'],
    canonicalCwd,
    configRoot,
    claudeEnv,
  )
  assertBranchContext('claude-cross', 'CLAUDE_CROSS_PROMPT')
  assert(
    requestFor('claude-cross').includes('BRANCH_ANSWER'),
    'Claude did not resume Praxis branch',
  )

  const claudeForkSourceId = '62626262-6262-4262-8262-626262626262'
  const praxisForkSourceId = '63636363-6363-4363-8363-636363636363'
  await cloneSession(claudeForkSourceId)
  await cloneSession(praxisForkSourceId)
  mode = 'claude-fork'
  const claudeFork = await runClaudeJson(
    [
      ...claudeCommon,
      '--resume',
      claudeForkSourceId,
      '--resume-session-at',
      target.uuid,
      '--fork-session',
      'CLAUDE_FORK_BRANCH_PROMPT',
    ],
    canonicalCwd,
    configRoot,
    claudeEnv,
  )
  const praxisForkId = '64646464-6464-4464-8464-646464646464'
  mode = 'praxis-fork'
  await praxis(
    '-p',
    '--output-format=json',
    '--resume',
    praxisForkSourceId,
    '--resume-session-at',
    target.uuid,
    '--fork-session',
    '--session-id',
    praxisForkId,
    '--',
    'PRAXIS_FORK_BRANCH_PROMPT',
  )
  for (const [label, sessionId, prompt] of [
    ['Claude', claudeFork.session_id, 'CLAUDE_FORK_BRANCH_PROMPT'],
    ['Praxis', praxisForkId, 'PRAXIS_FORK_BRANCH_PROMPT'],
  ]) {
    const path = resolveClaudePaths({
      configDir: configRoot,
      cwd: canonicalCwd,
      sessionId,
    }).sessionFile
    const source = await readFile(path, 'utf8')
    assert(source.includes('SECOND_PROMPT'), `${label} fork omitted target`)
    assert(
      !source.includes('SECOND_ANSWER'),
      `${label} fork retained target answer`,
    )
    assert(
      !source.includes('ABANDONED_PROMPT'),
      `${label} fork retained descendant`,
    )
    assert(source.includes(prompt), `${label} fork omitted new prompt`)
  }

  const ephemeralSourceId = '65656565-6565-4565-8565-656565656565'
  const ephemeralPaths = await cloneSession(ephemeralSourceId)
  const ephemeralBefore = await readFile(ephemeralPaths.sessionFile, 'utf8')
  mode = 'praxis-ephemeral'
  await praxis(
    '-p',
    '--output-format=json',
    '--no-session-persistence',
    '--resume',
    ephemeralSourceId,
    '--resume-session-at',
    target.uuid,
    '--',
    'BRANCH_PROMPT',
  )
  assertBranchContext('praxis-ephemeral', 'BRANCH_PROMPT')
  assert(
    (await readFile(ephemeralPaths.sessionFile, 'utf8')) === ephemeralBefore,
    'Ephemeral resume-at mutated persisted transcript',
  )

  const claudeAssistantSourceId = '67676767-6767-4767-8767-676767676767'
  const praxisAssistantSourceId = '68686868-6868-4868-8868-686868686868'
  const claudeAssistantPaths = await cloneSession(claudeAssistantSourceId)
  const praxisAssistantPaths = await cloneSession(praxisAssistantSourceId)
  mode = 'claude-assistant-target'
  await runClaudeJson(
    [
      ...claudeCommon,
      '--resume',
      claudeAssistantSourceId,
      '--resume-session-at',
      targetAnswer.uuid,
      'CLAUDE_ASSISTANT_BRANCH_PROMPT',
    ],
    canonicalCwd,
    configRoot,
    claudeEnv,
  )
  mode = 'praxis-assistant-target'
  await praxis(
    '-p',
    '--output-format=json',
    '--resume',
    praxisAssistantSourceId,
    '--resume-session-at',
    targetAnswer.uuid,
    '--',
    'PRAXIS_ASSISTANT_BRANCH_PROMPT',
  )
  for (const [label, requestMode, prompt, path] of [
    [
      'Claude',
      'claude-assistant-target',
      'CLAUDE_ASSISTANT_BRANCH_PROMPT',
      claudeAssistantPaths.sessionFile,
    ],
    [
      'Praxis',
      'praxis-assistant-target',
      'PRAXIS_ASSISTANT_BRANCH_PROMPT',
      praxisAssistantPaths.sessionFile,
    ],
  ]) {
    const source = requestFor(requestMode)
    assert(
      source.includes('SECOND_ANSWER'),
      `${label} omitted assistant target`,
    )
    assert(source.includes(prompt), `${label} omitted assistant branch prompt`)
    assert(
      !source.includes('ABANDONED_PROMPT'),
      `${label} retained assistant descendants`,
    )
    assert(
      messageEntry(await entries(path), prompt).parentUuid ===
        targetAnswer.uuid,
      `${label} assistant branch parent differs`,
    )
  }

  for (const [label, command, expected] of [
    [
      'Praxis assistant target',
      () =>
        praxis(
          '-p',
          '--resume',
          praxisSourceId,
          '--resume-session-at',
          targetAnswer.uuid,
          '--',
          'invalid',
        ),
      `No message found with message.uuid of: ${targetAnswer.uuid}`,
    ],
    [
      'Claude assistant target',
      () =>
        runClaudeJson(
          [
            ...claudeCommon,
            '--resume',
            first.session_id,
            '--resume-session-at',
            targetAnswer.uuid,
            'invalid',
          ],
          canonicalCwd,
          configRoot,
          claudeEnv,
        ),
      `No message found with message.uuid of: ${targetAnswer.uuid}`,
    ],
  ]) {
    let failure = ''
    try {
      await command()
    } catch (error) {
      failure = `${error.stderr ?? ''}${error.message ?? ''}`
    }
    assert(
      failure.includes(expected),
      `${label} accepted invalid target: ${failure || '<no error>'}`,
    )
  }

  const backgroundSourceId = '66666666-6666-4666-8666-666666666666'
  const backgroundPaths = await cloneSession(backgroundSourceId)
  mode = 'praxis-background'
  const background = await praxis(
    '--background',
    '--resume',
    backgroundSourceId,
    '--resume-session-at',
    target.uuid,
    '--',
    'BACKGROUND_BRANCH_PROMPT',
  )
  const jobId = /backgrounded · ([a-z0-9]+)/u.exec(background.stdout)?.[1]
  assert(
    jobId,
    `Background resume-at did not return a job: ${background.stdout}`,
  )
  try {
    await waitForRequest('praxis-background')
    assertBranchContext('praxis-background', 'BACKGROUND_BRANCH_PROMPT')
    const backgroundEntries = await entries(backgroundPaths.sessionFile)
    assert(
      messageEntry(backgroundEntries, 'BACKGROUND_BRANCH_PROMPT').parentUuid ===
        target.uuid,
      'Background branch parent differs',
    )
  } finally {
    await praxis('stop', jobId).catch(() => undefined)
  }

  console.log(
    'resume-session-at compatibility passed: active-message validation, append-only branch projection, native fork truncation, ephemeral mode, background dispatch, and Claude/Praxis bidirectional resume match Claude 2.1.208.',
  )
} finally {
  if (server.listening) await closeServer()
  await rm(root, { recursive: true, force: true })
}
