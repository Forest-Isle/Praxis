import { execFile } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import { detectClaudeVersion, writeFixture } from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const probeRoot = await mkdtemp(join(tmpdir(), 'praxis-cli-controls-'))
const requests = []
const betaHeaders = []
let responseNumber = 0

const server = createServer(async (request, response) => {
  if (request.method === 'HEAD') {
    response.writeHead(200).end()
    return
  }
  let source = ''
  request.setEncoding('utf8')
  for await (const chunk of request) source += chunk
  if (!source || !request.url?.startsWith('/v1/messages')) {
    response.writeHead(404).end()
    return
  }
  requests.push(JSON.parse(source))
  betaHeaders.push(request.headers['anthropic-beta'] ?? null)
  responseNumber += 1
  const text = `CLI_CONTROL_RESPONSE_${responseNumber}`
  const events = [
    {
      type: 'message_start',
      message: {
        id: `msg_cli_control_${responseNumber}`,
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

function markers(request) {
  return [...JSON.stringify(request).matchAll(/[A-Z_]+MARKER_\d+/g)].map(
    (match) => match[0],
  )
}

function toolNames(request) {
  return Array.isArray(request?.tools)
    ? request.tools.map((tool) => tool.name)
    : []
}

function systemText(request) {
  return JSON.stringify(request?.system ?? request?.messages ?? [])
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} mismatch: ${JSON.stringify({ actual, expected })}`,
    )
  }
}

function result(stdout) {
  const value = JSON.parse(stdout)
  if (value.type !== 'result' || value.is_error === true) {
    throw new Error(`Praxis failed: ${stdout}`)
  }
  return value
}

try {
  const configRoot = join(probeRoot, 'config')
  const workDirectory = join(probeRoot, 'work')
  const additionalDirectory = join(probeRoot, 'additional')
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(workDirectory, { recursive: true }),
    mkdir(additionalDirectory, { recursive: true }),
  ])
  const cwd = await realpath(workDirectory)
  const userMarker = 'USER_CONTEXT_MARKER_6101'
  const projectMarker = 'PROJECT_CONTEXT_MARKER_6102'
  const systemMarker = 'SYSTEM_FILE_MARKER_6103'
  const appendMarker = 'APPEND_FILE_MARKER_6104'
  await Promise.all([
    writeFixture(join(configRoot, 'CLAUDE.md'), userMarker),
    writeFixture(join(cwd, 'CLAUDE.md'), projectMarker),
    writeFile(join(probeRoot, 'system.txt'), systemMarker),
    writeFile(join(probeRoot, 'append.txt'), appendMarker),
  ])

  await listen()
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('CLI controls fixture server has no TCP address')
  }
  const baseUrl = `http://127.0.0.1:${address.port}`
  const environment = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configRoot,
    PRAXIS_PROVIDER: 'anthropic',
    PRAXIS_API_KEY: 'fixture-key',
    PRAXIS_MODEL: 'fixture-model',
    PRAXIS_BASE_URL: `${baseUrl}/v1`,
    PRAXIS_ANTHROPIC_WEB_SEARCH: 'true',
  }
  const cliPath = join(process.cwd(), 'dist', 'cli.js')
  async function runPraxis(args) {
    const before = requests.length
    const execution = await execFileAsync(
      process.execPath,
      [cliPath, '-p', '--output-format', 'json', ...args],
      { cwd, env: environment },
    )
    return { result: result(execution.stdout), request: requests[before] }
  }

  const defaultRun = await runPraxis(['--no-session-persistence', 'default'])
  assertEqual(
    markers(defaultRun.request),
    [userMarker, projectMarker],
    'default shared context',
  )
  const systemRun = await runPraxis([
    '--no-session-persistence',
    '--system-prompt-file',
    join(probeRoot, 'system.txt'),
    'system',
  ])
  assertEqual(
    markers(systemRun.request),
    [systemMarker, userMarker, projectMarker],
    'system prompt order',
  )
  const appendRun = await runPraxis([
    '--no-session-persistence',
    '--append-system-prompt-file',
    join(probeRoot, 'append.txt'),
    'append',
  ])
  assertEqual(
    markers(appendRun.request),
    [userMarker, projectMarker, appendMarker],
    'appended prompt order',
  )
  const userOnly = await runPraxis([
    '--no-session-persistence',
    '--setting-sources',
    'user',
    'user source',
  ])
  assertEqual(markers(userOnly.request), [userMarker], 'user source')

  const debugFile = join(probeRoot, 'debug', 'runtime.jsonl')
  await runPraxis([
    '--no-session-persistence',
    '--debug=state',
    '--debug-file',
    debugFile,
    'debug file',
  ])
  const debugContent = await readFile(debugFile, 'utf8')
  if (!debugContent.includes('"type":"state"')) {
    throw new Error('Debug file did not contain filtered runtime state events')
  }
  if (debugContent.includes('"type":"text-delta"')) {
    throw new Error('Debug filter did not exclude text delta events')
  }

  await runPraxis([
    '--no-session-persistence',
    '--betas',
    'fixture-beta-a',
    'fixture-beta-b',
    '--',
    'beta headers',
  ])
  if (betaHeaders.at(-1) !== 'fixture-beta-a,fixture-beta-b') {
    throw new Error(`Anthropic beta header mismatch: ${betaHeaders.at(-1)}`)
  }

  const inlineAgentMarker = 'INLINE_AGENT_MARKER_6110'
  const inlineAgent = await runPraxis([
    '--no-session-persistence',
    '--agents',
    JSON.stringify({
      reviewer: { description: 'Review files', prompt: inlineAgentMarker },
    }),
    '--agent',
    'reviewer',
    'inline agent',
  ])
  if (!systemText(inlineAgent.request).includes(inlineAgentMarker)) {
    throw new Error('Inline --agents prompt was not included in agent context')
  }

  const briefRun = await runPraxis([
    '--no-session-persistence',
    '--brief',
    'brief tool',
  ])
  if (!toolNames(briefRun.request).includes('SendUserMessage')) {
    throw new Error('--brief did not expose SendUserMessage')
  }
  if (
    !systemText(briefRun.request).includes('primary user-visible reply channel')
  ) {
    throw new Error('--brief did not add SendUserMessage guidance')
  }

  const slashDisabled = await runPraxis([
    '--no-session-persistence',
    '--disable-slash-commands',
    'slash disabled',
  ])
  if (toolNames(slashDisabled.request).includes('Skill')) {
    throw new Error('--disable-slash-commands left Skill tool enabled')
  }
  for (const [label, args, expectedTools] of [
    [
      'safe',
      ['--safe-mode'],
      [
        'Read',
        'Write',
        'Edit',
        'NotebookEdit',
        'Glob',
        'Grep',
        'Bash',
        'WebFetch',
        'WebSearch',
        'Skill',
        'CronCreate',
        'CronDelete',
        'CronList',
        'ScheduleWakeup',
        'Agent',
        'SendMessage',
        'EnterWorktree',
        'ExitWorktree',
      ],
    ],
    ['bare', ['--bare'], ['Bash', 'Edit', 'Read']],
    ['empty tools', ['--tools='], []],
    ['read tools', ['--tools=Read'], ['Read']],
  ]) {
    const execution = await runPraxis([
      '--no-session-persistence',
      ...args,
      label,
    ])
    if (label === 'safe' || label === 'bare') {
      assertEqual(markers(execution.request), [], `${label} context`)
    }
    assertEqual(toolNames(execution.request), expectedTools, `${label} tools`)
  }

  const noPersistenceId = '11111111-1111-4111-8111-111111111111'
  await runPraxis([
    '--session-id',
    noPersistenceId,
    '--no-session-persistence',
    'ephemeral',
  ])
  const ephemeralPath = resolveClaudePaths({
    configDir: configRoot,
    cwd,
    sessionId: noPersistenceId,
  }).sessionFile
  await access(ephemeralPath).then(
    () => {
      throw new Error('No-persistence session wrote a transcript')
    },
    (error) => {
      if (error.code !== 'ENOENT') throw error
    },
  )

  const namedId = '22222222-2222-4222-8222-222222222222'
  await runPraxis([
    '--session-id',
    namedId,
    '--name',
    'Named compatibility session',
    'named',
  ])
  const namedPath = resolveClaudePaths({
    configDir: configRoot,
    cwd,
    sessionId: namedId,
  }).sessionFile
  const namedEntries = (await readFile(namedPath, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
  assertEqual(
    namedEntries.slice(0, 2),
    [
      {
        type: 'custom-title',
        customTitle: 'Named compatibility session',
        sessionId: namedId,
      },
      {
        type: 'agent-name',
        agentName: 'Named compatibility session',
        sessionId: namedId,
      },
    ],
    'native session name entries',
  )

  const praxisForkId = '33333333-3333-4333-8333-333333333333'
  const praxisFork = await runPraxis([
    '--resume',
    namedId,
    '--fork-session',
    '--session-id',
    praxisForkId,
    'fork named session in Praxis',
  ])
  assertEqual(
    praxisFork.result.session_id,
    praxisForkId,
    'Praxis explicit fork identity',
  )

  const version = await detectClaudeVersion('CLI controls probe')
  const claudeExecution = await execFileAsync(
    'claude',
    [
      '-p',
      '--resume',
      praxisForkId,
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      '1',
      '--tools=',
      '--output-format',
      'json',
      'resume named session',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: baseUrl,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    },
  )
  const claudeResult = JSON.parse(claudeExecution.stdout)
  if (
    claudeResult.session_id !== praxisForkId ||
    claudeResult.is_error === true
  ) {
    throw new Error(
      `Claude could not resume named session: ${claudeExecution.stdout}`,
    )
  }

  const explicitForkId = '44444444-4444-4444-8444-444444444444'
  const claudeForkExecution = await execFileAsync(
    'claude',
    [
      '-p',
      '--resume',
      namedId,
      '--fork-session',
      '--session-id',
      explicitForkId,
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      '1',
      '--tools=',
      '--output-format',
      'json',
      'fork named session',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: baseUrl,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    },
  )
  const claudeForkResult = JSON.parse(claudeForkExecution.stdout)
  if (
    claudeForkResult.session_id !== explicitForkId ||
    claudeForkResult.is_error === true
  ) {
    throw new Error(
      `Claude did not honor explicit fork identity: ${claudeForkExecution.stdout}`,
    )
  }

  const persistedBeforeEphemeralResume = await readFile(namedPath)
  const ephemeralResume = await runPraxis([
    '--resume',
    namedId,
    '--no-session-persistence',
    'ephemeral resume',
  ])
  if (!JSON.stringify(ephemeralResume.request).includes('named')) {
    throw new Error('Ephemeral resume did not import persisted history')
  }
  assertEqual(
    await readFile(namedPath),
    persistedBeforeEphemeralResume,
    'ephemeral resume source transcript',
  )

  console.log(
    `Claude ${version} CLI controls passed: prompts, sources, modes, inline agents, disabled slash commands, beta headers, debug file, tools, explicit fork identity, ephemeral storage, and named resume`,
  )
} finally {
  if (server.listening) await closeServer()
  await rm(probeRoot, { recursive: true })
}
