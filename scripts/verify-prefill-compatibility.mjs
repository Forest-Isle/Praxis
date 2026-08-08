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
import { join } from 'node:path'

import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import {
  detectClaudeVersion,
  execFileAsync,
  runClaudeJson,
} from './lib/claude-probe.mjs'

const root = await mkdtemp(join(tmpdir(), 'praxis-prefill-compat-'))
const cwd = await realpath(root)
const claudeConfig = join(root, 'claude-config')
const praxisConfig = join(root, 'praxis-config')
const requests = []

const markers = {
  claudeInitial: 'CLAUDE_PREFILL_INITIAL_6501',
  claudeResume: 'CLAUDE_PREFILL_RESUME_6502',
  claudeStream: 'CLAUDE_PREFILL_STREAM_6503',
  claudeFork: 'CLAUDE_PREFILL_FORK_6504',
  claudeDuplicateFirst: 'CLAUDE_PREFILL_DUPLICATE_FIRST_6505',
  claudeDuplicateLast: 'CLAUDE_PREFILL_DUPLICATE_LAST_6506',
  praxisInitial: 'PRAXIS_PREFILL_INITIAL_6511',
  praxisResume: 'PRAXIS_PREFILL_RESUME_6512',
  praxisStream: 'PRAXIS_PREFILL_STREAM_6513',
  praxisFork: 'PRAXIS_PREFILL_FORK_6514',
  praxisDuplicateFirst: 'PRAXIS_PREFILL_DUPLICATE_FIRST_6515',
  praxisDuplicateLast: 'PRAXIS_PREFILL_DUPLICATE_LAST_6516',
  praxisOpenAi: 'PRAXIS_PREFILL_OPENAI_6517',
}

function anthropicEvents(text) {
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_prefill_${randomUUID().replaceAll('-', '')}`,
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
  let source = ''
  request.setEncoding('utf8')
  for await (const chunk of request) source += chunk
  if (!source) {
    response.writeHead(404).end()
    return
  }
  const body = JSON.parse(source)
  const owner = request.headers['x-api-key'] ?? request.headers.authorization
  const text = `CONTINUATION_${requests.length + 1}`
  requests.push({ owner, url: request.url, body, text })
  if (request.url?.endsWith('/chat/completions')) {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''),
    )
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    anthropicEvents(text)
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
  )
})

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertAbsent(value, marker, label) {
  assert(!JSON.stringify(value).includes(marker), `${label} exposed ${marker}`)
}

function assertContains(value, marker, label) {
  assert(JSON.stringify(value).includes(marker), `${label} omitted ${marker}`)
}

function assertResult(value, expected, label) {
  assert(
    value?.type === 'result' && value.is_error === false,
    `${label} failed`,
  )
  assert(value.result === expected, `${label} returned unexpected output`)
}

function requestFor(owner, prompt) {
  const request = requests.find(
    (entry) =>
      entry.owner === owner && JSON.stringify(entry.body).includes(prompt),
  )
  assert(request, `provider did not receive ${prompt}`)
  return request
}

async function transcript(configRoot, sessionId) {
  const paths = resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
  return readFile(paths.sessionFile, 'utf8')
}

async function directoryText(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
  const values = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? directoryText(path) : readFile(path, 'utf8')
    }),
  )
  return values.join('\n')
}

async function runPraxis(args, environment) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [join(process.cwd(), 'dist', 'cli.js'), ...args],
    { cwd, env: { ...process.env, ...environment }, timeout: 120_000 },
  )
  return stdout
}

async function assertMissingValue(command, args, environment, label) {
  try {
    await execFileAsync(command, args, {
      cwd,
      env: { ...process.env, ...environment },
      timeout: 120_000,
    })
  } catch (error) {
    assert(error.code !== 0, `${label} did not fail`)
    assert(
      String(error.stderr).includes('--prefill'),
      `${label} did not identify --prefill`,
    )
    return
  }
  throw new Error(`${label} accepted a missing prefill value`)
}

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})

try {
  const version = await detectClaudeVersion('prefill compatibility gate')
  await Promise.all([
    mkdir(claudeConfig, { recursive: true }),
    mkdir(praxisConfig, { recursive: true }),
  ])
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const claudeEnv = {
    ANTHROPIC_API_KEY: 'claude-prefill-key',
    ANTHROPIC_BASE_URL: baseUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  const praxisEnv = {
    CLAUDE_CONFIG_DIR: praxisConfig,
    PRAXIS_PROVIDER: 'anthropic',
    PRAXIS_API_KEY: 'praxis-prefill-key',
    PRAXIS_MODEL: 'fixture-model',
    PRAXIS_BASE_URL: `${baseUrl}/v1`,
  }
  const claudeSession = '65000000-0000-4000-8000-000000000001'
  const claudeFork = '65000000-0000-4000-8000-000000000002'
  const praxisSession = '65000000-0000-4000-8000-000000000011'
  const praxisFork = '65000000-0000-4000-8000-000000000012'

  await assertMissingValue(
    'claude',
    ['-p', '--prefill'],
    { ...claudeEnv, CLAUDE_CONFIG_DIR: claudeConfig },
    'Claude missing prefill value',
  )
  await assertMissingValue(
    process.execPath,
    [join(process.cwd(), 'dist', 'cli.js'), '-p', '--prefill'],
    praxisEnv,
    'Praxis missing prefill value',
  )

  const claudeInitial = await runClaudeJson(
    [
      '-p',
      '--model',
      'fixture-model',
      '--session-id',
      claudeSession,
      '--prefill',
      markers.claudeInitial,
      '--output-format',
      'json',
      'CLAUDE_PROMPT_INITIAL',
    ],
    cwd,
    claudeConfig,
    claudeEnv,
  )
  const claudeInitialRequest = requestFor(
    'claude-prefill-key',
    'CLAUDE_PROMPT_INITIAL',
  )
  assertResult(
    claudeInitial,
    claudeInitialRequest.text,
    'Claude initial prefill',
  )

  const claudeResume = await runClaudeJson(
    [
      '-p',
      '--model',
      'fixture-model',
      '--resume',
      claudeSession,
      '--prefill',
      markers.claudeResume,
      '--output-format',
      'json',
      'CLAUDE_PROMPT_RESUME',
    ],
    cwd,
    claudeConfig,
    claudeEnv,
  )
  const claudeResumeRequest = requestFor(
    'claude-prefill-key',
    'CLAUDE_PROMPT_RESUME',
  )
  assertResult(claudeResume, claudeResumeRequest.text, 'Claude resume prefill')
  assertContains(
    claudeResumeRequest.body,
    'CLAUDE_PROMPT_INITIAL',
    'Claude resume request',
  )
  assertContains(
    claudeResumeRequest.body,
    claudeInitialRequest.text,
    'Claude resume request',
  )

  const claudeForked = await runClaudeJson(
    [
      '-p',
      '--model',
      'fixture-model',
      '--resume',
      claudeSession,
      '--fork-session',
      '--session-id',
      claudeFork,
      '--prefill',
      markers.claudeFork,
      '--output-format',
      'json',
      'CLAUDE_PROMPT_FORK',
    ],
    cwd,
    claudeConfig,
    claudeEnv,
  )
  const claudeForkRequest = requestFor(
    'claude-prefill-key',
    'CLAUDE_PROMPT_FORK',
  )
  assertResult(claudeForked, claudeForkRequest.text, 'Claude fork prefill')
  for (const value of [
    'CLAUDE_PROMPT_INITIAL',
    claudeInitialRequest.text,
    'CLAUDE_PROMPT_RESUME',
    claudeResumeRequest.text,
  ]) {
    assertContains(claudeForkRequest.body, value, 'Claude fork request')
  }

  const claudeStreamId = '65000000-0000-4000-8000-000000000003'
  const claudeStream = await execFileAsync(
    'claude',
    [
      '-p',
      '--model',
      'fixture-model',
      '--session-id',
      claudeStreamId,
      '--output-format',
      'stream-json',
      '--verbose',
      '--prefill',
      markers.claudeStream,
      'CLAUDE_PROMPT_STREAM',
    ],
    {
      cwd,
      env: { ...process.env, ...claudeEnv, CLAUDE_CONFIG_DIR: claudeConfig },
      timeout: 120_000,
    },
  )
  const claudeStreamRequest = requestFor(
    'claude-prefill-key',
    'CLAUDE_PROMPT_STREAM',
  )
  assert(
    claudeStream.stdout.includes(claudeStreamRequest.text),
    'Claude stream omitted continuation',
  )

  const claudeDuplicate = await execFileAsync(
    'claude',
    [
      '-p',
      '--model',
      'fixture-model',
      '--no-session-persistence',
      '--prefill',
      markers.claudeDuplicateFirst,
      '--prefill',
      markers.claudeDuplicateLast,
      'CLAUDE_PROMPT_DUPLICATE',
    ],
    {
      cwd,
      env: { ...process.env, ...claudeEnv, CLAUDE_CONFIG_DIR: claudeConfig },
      timeout: 120_000,
    },
  )
  const claudeDuplicateRequest = requestFor(
    'claude-prefill-key',
    'CLAUDE_PROMPT_DUPLICATE',
  )
  assert(
    claudeDuplicate.stdout.trim() === claudeDuplicateRequest.text,
    'Claude duplicate prefill returned unexpected text output',
  )

  const praxisInitial = JSON.parse(
    await runPraxis(
      [
        '-p',
        '--session-id',
        praxisSession,
        '--prefill',
        markers.praxisInitial,
        '--output-format',
        'json',
        'PRAXIS_PROMPT_INITIAL',
      ],
      praxisEnv,
    ),
  )
  const praxisInitialRequest = requestFor(
    'praxis-prefill-key',
    'PRAXIS_PROMPT_INITIAL',
  )
  assertResult(
    praxisInitial,
    praxisInitialRequest.text,
    'Praxis initial prefill',
  )

  const praxisResume = JSON.parse(
    await runPraxis(
      [
        '-p',
        '--resume',
        praxisSession,
        '--prefill',
        markers.praxisResume,
        '--output-format',
        'json',
        'PRAXIS_PROMPT_RESUME',
      ],
      praxisEnv,
    ),
  )
  const praxisResumeRequest = requestFor(
    'praxis-prefill-key',
    'PRAXIS_PROMPT_RESUME',
  )
  assertResult(praxisResume, praxisResumeRequest.text, 'Praxis resume prefill')
  assertContains(
    praxisResumeRequest.body,
    'PRAXIS_PROMPT_INITIAL',
    'Praxis resume request',
  )
  assertContains(
    praxisResumeRequest.body,
    praxisInitialRequest.text,
    'Praxis resume request',
  )

  const praxisForked = JSON.parse(
    await runPraxis(
      [
        '-p',
        '--resume',
        praxisSession,
        '--fork-session',
        '--session-id',
        praxisFork,
        '--prefill',
        markers.praxisFork,
        '--output-format',
        'json',
        'PRAXIS_PROMPT_FORK',
      ],
      praxisEnv,
    ),
  )
  const praxisForkRequest = requestFor(
    'praxis-prefill-key',
    'PRAXIS_PROMPT_FORK',
  )
  assertResult(praxisForked, praxisForkRequest.text, 'Praxis fork prefill')
  for (const value of [
    'PRAXIS_PROMPT_INITIAL',
    praxisInitialRequest.text,
    'PRAXIS_PROMPT_RESUME',
    praxisResumeRequest.text,
  ]) {
    assertContains(praxisForkRequest.body, value, 'Praxis fork request')
  }

  const praxisStreamId = '65000000-0000-4000-8000-000000000013'
  const praxisStream = await runPraxis(
    [
      '-p',
      '--session-id',
      praxisStreamId,
      '--output-format',
      'stream-json',
      '--verbose',
      '--prefill',
      markers.praxisStream,
      'PRAXIS_PROMPT_STREAM',
    ],
    praxisEnv,
  )
  const praxisStreamRequest = requestFor(
    'praxis-prefill-key',
    'PRAXIS_PROMPT_STREAM',
  )
  assert(
    praxisStream.includes(praxisStreamRequest.text),
    'Praxis stream omitted continuation',
  )

  const praxisDuplicate = await runPraxis(
    [
      '-p',
      '--no-session-persistence',
      '--prefill',
      markers.praxisDuplicateFirst,
      '--prefill',
      markers.praxisDuplicateLast,
      'PRAXIS_PROMPT_DUPLICATE',
    ],
    praxisEnv,
  )
  const praxisDuplicateRequest = requestFor(
    'praxis-prefill-key',
    'PRAXIS_PROMPT_DUPLICATE',
  )
  assert(
    praxisDuplicate.trim() === praxisDuplicateRequest.text,
    'Praxis duplicate prefill returned unexpected text output',
  )

  const praxisOpenAi = JSON.parse(
    await runPraxis(
      [
        '-p',
        '--no-session-persistence',
        '--prefill',
        markers.praxisOpenAi,
        '--output-format',
        'json',
        'PRAXIS_PROMPT_OPENAI',
      ],
      {
        ...praxisEnv,
        PRAXIS_PROVIDER: 'openai',
        PRAXIS_API_KEY: 'praxis-openai-key',
      },
    ),
  )
  const praxisOpenAiRequest = requestFor(
    'Bearer praxis-openai-key',
    'PRAXIS_PROMPT_OPENAI',
  )
  assertResult(praxisOpenAi, praxisOpenAiRequest.text, 'Praxis OpenAI prefill')

  const allPrefillMarkers = Object.values(markers)
  for (const marker of allPrefillMarkers) {
    assertAbsent(requests, marker, 'provider requests')
    assertAbsent(claudeStream.stdout, marker, 'Claude stream output')
    assertAbsent(praxisStream, marker, 'Praxis stream output')
  }
  for (const [label, configRoot, sessionId, expected] of [
    [
      'Claude session',
      claudeConfig,
      claudeSession,
      ['CLAUDE_PROMPT_INITIAL', 'CLAUDE_PROMPT_RESUME'],
    ],
    [
      'Claude fork',
      claudeConfig,
      claudeFork,
      ['CLAUDE_PROMPT_INITIAL', 'CLAUDE_PROMPT_RESUME', 'CLAUDE_PROMPT_FORK'],
    ],
    [
      'Praxis session',
      praxisConfig,
      praxisSession,
      ['PRAXIS_PROMPT_INITIAL', 'PRAXIS_PROMPT_RESUME'],
    ],
    [
      'Praxis fork',
      praxisConfig,
      praxisFork,
      ['PRAXIS_PROMPT_INITIAL', 'PRAXIS_PROMPT_RESUME', 'PRAXIS_PROMPT_FORK'],
    ],
  ]) {
    const source = await transcript(configRoot, sessionId)
    for (const marker of allPrefillMarkers) assertAbsent(source, marker, label)
    for (const value of expected) assertContains(source, value, label)
  }
  assertAbsent(
    await directoryText(claudeConfig),
    'CLAUDE_PROMPT_DUPLICATE',
    'Claude non-persistent storage',
  )
  assertAbsent(
    await directoryText(praxisConfig),
    'PRAXIS_PROMPT_DUPLICATE',
    'Praxis non-persistent storage',
  )
  for (const [label, value] of [
    ['Claude initial output', claudeInitial],
    ['Claude resume output', claudeResume],
    ['Claude fork output', claudeForked],
    ['Claude duplicate output', claudeDuplicate.stdout],
    ['Praxis initial output', praxisInitial],
    ['Praxis resume output', praxisResume],
    ['Praxis fork output', praxisForked],
    ['Praxis duplicate output', praxisDuplicate],
    ['Praxis OpenAI output', praxisOpenAi],
  ]) {
    for (const marker of allPrefillMarkers) assertAbsent(value, marker, label)
  }

  console.log(
    `Claude ${version} prefill compatibility passed: accepted no-op across text, JSON, stream-json, persistence, resume, fork, duplicates, and OpenAI-compatible Praxis routing`,
  )
} finally {
  await new Promise((resolve) => server.close(resolve)).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}
