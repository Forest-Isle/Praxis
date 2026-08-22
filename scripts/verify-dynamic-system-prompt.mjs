import { randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import { detectClaudeVersion, execFileAsync } from './lib/claude-probe.mjs'

const root = await mkdtemp(join(tmpdir(), 'praxis-dynamic-system-compat-'))
const cwd = join(root, 'work')
const claudeConfigRoot = join(root, 'claude-config')
const praxisConfigRoot = join(root, 'praxis-config')
const requests = []

function textEvents(text) {
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_${randomUUID().replaceAll('-', '')}`,
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
  requests.push(JSON.parse(source))
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    textEvents('DYNAMIC_SYSTEM_FIXTURE_RESPONSE')
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

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function systemText(request) {
  return contentText(request?.system)
}

function messageText(message) {
  return contentText(message?.content)
}

function payloadText(request) {
  return [
    systemText(request),
    ...(request?.messages ?? []).map((message) => messageText(message)),
  ].join('\n')
}

function firstUserText(request) {
  return messageText(
    request?.messages?.find((message) => message.role === 'user'),
  )
}

function primaryRequest(prompt) {
  const selected = requests.findLast(
    (request) =>
      JSON.stringify(request?.messages ?? []).includes(prompt) &&
      !systemText(request).includes('Generate a concise, sentence-case title'),
  )
  if (!selected)
    throw new Error(`Provider received no primary request for ${prompt}`)
  requests.length = 0
  return selected
}

function assertContains(value, marker, label) {
  if (!value.includes(marker)) throw new Error(`${label} missing ${marker}`)
}

function assertNotContains(value, marker, label) {
  if (value.includes(marker)) throw new Error(`${label} leaked ${marker}`)
}

async function runClaude(args, prompt, environment) {
  const { stdout } = await execFileAsync(
    'claude',
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--output-format',
      'json',
      ...args,
      prompt,
    ],
    { cwd, env: environment, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  )
  return { result: JSON.parse(stdout), request: primaryRequest(prompt) }
}

async function runPraxis(args, prompt, environment) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), 'dist', 'cli.js'),
      '-p',
      '--output-format=json',
      '--max-turns',
      '1',
      ...args,
      '--',
      prompt,
    ],
    { cwd, env: environment, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  )
  return { result: JSON.parse(stdout), request: primaryRequest(prompt) }
}

async function runPraxisStream(args, prompt, environment) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), 'dist', 'cli.js'),
      '-p',
      '--output-format=stream-json',
      '--verbose',
      '--max-turns',
      '1',
      ...args,
      '--',
      prompt,
    ],
    { cwd, env: environment, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  )
  const records = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const result = records.findLast((record) => record.type === 'result')
  if (!result) throw new Error(`Missing stream-json result for ${prompt}`)
  return { result, records, request: primaryRequest(prompt) }
}

function assertRelocated(request, prompt, label) {
  const system = systemText(request)
  const firstUser = firstUserText(request)
  for (const marker of ['Primary working directory:', '# gitStatus']) {
    assertNotContains(system, marker, `${label} system`)
    assertContains(firstUser, marker, `${label} first user`)
  }
  assertContains(system, '# Memory', `${label} system`)
  assertNotContains(firstUser, '# Memory', `${label} first user`)
  assertContains(firstUser, prompt, `${label} first user`)
  assertContains(firstUser, '<system-reminder>', `${label} first user`)
}

function assertDefaultSystem(request, label) {
  const system = systemText(request)
  for (const marker of [
    'Primary working directory:',
    '# Memory',
    'gitStatus',
  ]) {
    assertContains(system, marker, `${label} system`)
  }
  assertNotContains(
    firstUserText(request),
    'Primary working directory:',
    `${label} first user`,
  )
}

try {
  const version = await detectClaudeVersion(
    'dynamic system prompt compatibility',
  )
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(claudeConfigRoot, { recursive: true }),
    mkdir(praxisConfigRoot, { recursive: true }),
  ])
  const canonicalCwd = await realpath(cwd)
  await Promise.all([
    writeFile(join(canonicalCwd, 'CLAUDE.md'), 'PROJECT_INSTRUCTION_MARKER'),
    writeFile(join(canonicalCwd, 'tracked.txt'), 'base\n'),
  ])
  await execFileAsync('git', ['init', '--quiet'], { cwd: canonicalCwd })
  await execFileAsync('git', ['add', 'CLAUDE.md', 'tracked.txt'], {
    cwd: canonicalCwd,
  })
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Probe',
      '-c',
      'user.email=probe@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'base',
    ],
    { cwd: canonicalCwd },
  )
  await Promise.all([
    writeFile(join(canonicalCwd, 'tracked.txt'), 'changed\n'),
    writeFile(join(canonicalCwd, 'untracked.txt'), 'new\n'),
  ])

  await listen()
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('No fixture address')
  const origin = `http://127.0.0.1:${address.port}`
  const claudeEnvironment = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeConfigRoot,
    ANTHROPIC_BASE_URL: origin,
    ANTHROPIC_AUTH_TOKEN: 'fixture-key',
    ANTHROPIC_API_KEY: '',
  }
  const praxisEnvironment = {
    ...process.env,
    CLAUDE_CONFIG_DIR: praxisConfigRoot,
    PRAXIS_PROVIDER: 'anthropic',
    PRAXIS_BASE_URL: `${origin}/v1`,
    PRAXIS_API_KEY: 'fixture-key',
    PRAXIS_MODEL: 'fixture-model',
  }

  const claudeDefault = await runClaude(
    [],
    'CLAUDE_DYNAMIC_DEFAULT',
    claudeEnvironment,
  )
  assertDefaultSystem(claudeDefault.request, 'Claude default')
  const claudeExcluded = await runClaude(
    ['--exclude-dynamic-system-prompt-sections'],
    'CLAUDE_DYNAMIC_EXCLUDED',
    claudeEnvironment,
  )
  assertRelocated(
    claudeExcluded.request,
    'CLAUDE_DYNAMIC_EXCLUDED',
    'Claude excluded',
  )
  await writeFile(join(canonicalCwd, 'after-claude-turn.txt'), 'later\n')
  const claudeResumed = await runClaude(
    [
      '--resume',
      claudeExcluded.result.session_id,
      '--exclude-dynamic-system-prompt-sections',
    ],
    'CLAUDE_DYNAMIC_RESUME',
    claudeEnvironment,
  )
  assertRelocated(
    claudeResumed.request,
    'CLAUDE_DYNAMIC_EXCLUDED',
    'Claude resume',
  )
  assertContains(
    firstUserText(claudeResumed.request),
    'after-claude-turn.txt',
    'Claude refreshed git status',
  )
  assertNotContains(
    messageText(claudeResumed.request.messages.at(-1)),
    '# Environment',
    'Claude latest resume user',
  )
  const claudeCustom = await runClaude(
    [
      '--exclude-dynamic-system-prompt-sections',
      '--system-prompt',
      'CLAUDE_CUSTOM_SYSTEM',
    ],
    'CLAUDE_DYNAMIC_CUSTOM',
    claudeEnvironment,
  )
  assertContains(
    systemText(claudeCustom.request),
    'CLAUDE_CUSTOM_SYSTEM',
    'Claude custom',
  )
  for (const marker of ['# gitStatus', '# Memory']) {
    assertNotContains(
      payloadText(claudeCustom.request),
      marker,
      'Claude custom',
    )
  }
  const claudeAppended = await runClaude(
    [
      '--exclude-dynamic-system-prompt-sections',
      '--append-system-prompt',
      'CLAUDE_APPEND_SYSTEM',
    ],
    'CLAUDE_DYNAMIC_APPEND',
    claudeEnvironment,
  )
  assertRelocated(
    claudeAppended.request,
    'CLAUDE_DYNAMIC_APPEND',
    'Claude appended',
  )
  assertContains(
    systemText(claudeAppended.request),
    'CLAUDE_APPEND_SYSTEM',
    'Claude appended',
  )

  const praxisDefault = await runPraxis(
    [],
    'PRAXIS_DYNAMIC_DEFAULT',
    praxisEnvironment,
  )
  assertDefaultSystem(praxisDefault.request, 'Praxis default')
  const praxisExcluded = await runPraxis(
    ['--exclude-dynamic-system-prompt-sections'],
    'PRAXIS_DYNAMIC_EXCLUDED',
    praxisEnvironment,
  )
  assertRelocated(
    praxisExcluded.request,
    'PRAXIS_DYNAMIC_EXCLUDED',
    'Praxis excluded',
  )
  await writeFile(join(canonicalCwd, 'after-praxis-turn.txt'), 'later\n')
  const praxisResumed = await runPraxis(
    [
      '--resume',
      praxisExcluded.result.session_id,
      '--exclude-dynamic-system-prompt-sections',
    ],
    'PRAXIS_DYNAMIC_RESUME',
    praxisEnvironment,
  )
  assertRelocated(
    praxisResumed.request,
    'PRAXIS_DYNAMIC_EXCLUDED',
    'Praxis resume',
  )
  assertContains(
    firstUserText(praxisResumed.request),
    'after-praxis-turn.txt',
    'Praxis refreshed git status',
  )
  assertNotContains(
    messageText(praxisResumed.request.messages.at(-1)),
    '# Environment',
    'Praxis latest resume user',
  )
  const praxisCustom = await runPraxis(
    [
      '--exclude-dynamic-system-prompt-sections',
      '--system-prompt',
      'PRAXIS_CUSTOM_SYSTEM',
    ],
    'PRAXIS_DYNAMIC_CUSTOM',
    praxisEnvironment,
  )
  assertContains(
    systemText(praxisCustom.request),
    'PRAXIS_CUSTOM_SYSTEM',
    'Praxis custom',
  )
  assertRelocated(
    praxisCustom.request,
    'PRAXIS_DYNAMIC_CUSTOM',
    'Praxis custom',
  )
  const praxisAppended = await runPraxis(
    [
      '--exclude-dynamic-system-prompt-sections',
      '--append-system-prompt',
      'PRAXIS_APPEND_SYSTEM',
    ],
    'PRAXIS_DYNAMIC_APPEND',
    praxisEnvironment,
  )
  assertRelocated(
    praxisAppended.request,
    'PRAXIS_DYNAMIC_APPEND',
    'Praxis appended',
  )
  assertContains(
    systemText(praxisAppended.request),
    'PRAXIS_APPEND_SYSTEM',
    'Praxis appended',
  )

  const praxisForked = await runPraxis(
    [
      '--resume',
      praxisExcluded.result.session_id,
      '--fork-session',
      '--exclude-dynamic-system-prompt-sections',
    ],
    'PRAXIS_DYNAMIC_FORK',
    praxisEnvironment,
  )
  assertRelocated(
    praxisForked.request,
    'PRAXIS_DYNAMIC_EXCLUDED',
    'Praxis fork',
  )
  if (praxisForked.result.session_id === praxisExcluded.result.session_id) {
    throw new Error('Praxis fork reused source session id')
  }

  const praxisEphemeral = await runPraxis(
    ['--no-session-persistence', '--exclude-dynamic-system-prompt-sections'],
    'PRAXIS_DYNAMIC_EPHEMERAL',
    praxisEnvironment,
  )
  assertRelocated(
    praxisEphemeral.request,
    'PRAXIS_DYNAMIC_EPHEMERAL',
    'Praxis no-persistence',
  )

  const praxisStream = await runPraxisStream(
    ['--exclude-dynamic-system-prompt-sections'],
    'PRAXIS_DYNAMIC_STREAM_ONE',
    praxisEnvironment,
  )
  assertRelocated(
    praxisStream.request,
    'PRAXIS_DYNAMIC_STREAM_ONE',
    'Praxis stream-json',
  )
  if (!praxisStream.records.some((record) => record.type === 'assistant')) {
    throw new Error('Praxis stream-json emitted no assistant record')
  }
  const praxisStreamResumed = await runPraxisStream(
    [
      '--resume',
      praxisStream.result.session_id,
      '--exclude-dynamic-system-prompt-sections',
    ],
    'PRAXIS_DYNAMIC_STREAM_TWO',
    praxisEnvironment,
  )
  assertRelocated(
    praxisStreamResumed.request,
    'PRAXIS_DYNAMIC_STREAM_ONE',
    'Praxis stream-json resume',
  )

  const transcriptPath = resolveClaudePaths({
    configDir: praxisConfigRoot,
    cwd: canonicalCwd,
    sessionId: praxisExcluded.result.session_id,
  }).sessionFile
  const transcript = await readFile(transcriptPath, 'utf8')
  for (const marker of [
    '<system-reminder>',
    '# Environment',
    'after-praxis-turn.txt',
  ]) {
    assertNotContains(transcript, marker, 'Praxis transcript')
  }
  const forkTranscript = await readFile(
    resolveClaudePaths({
      configDir: praxisConfigRoot,
      cwd: canonicalCwd,
      sessionId: praxisForked.result.session_id,
    }).sessionFile,
    'utf8',
  )
  assertNotContains(
    forkTranscript,
    '<system-reminder>',
    'Praxis fork transcript',
  )
  const ephemeralPath = resolveClaudePaths({
    configDir: praxisConfigRoot,
    cwd: canonicalCwd,
    sessionId: praxisEphemeral.result.session_id,
  }).sessionFile
  await stat(ephemeralPath).then(
    () => {
      throw new Error('Praxis no-persistence wrote a shared transcript')
    },
    (error) => {
      if (error?.code !== 'ENOENT') throw error
    },
  )

  console.log(
    `Claude ${version} dynamic system prompt compatibility passed: default placement, first-user relocation, resume/fork refresh, stream-json multi-turn, no-persistence, Praxis custom-base replacement, append preservation, and transcript isolation.`,
  )
} finally {
  if (server.listening) await closeServer().catch(() => undefined)
  await rm(root, { recursive: true })
}
