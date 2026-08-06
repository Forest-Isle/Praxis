import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { detectClaudeVersion } from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-worktree-compat-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'repo')
const sessionId = '55555555-5555-4555-8555-555555555555'
const cliSessionId = '66666666-6666-4666-8666-666666666666'
let mode = 'claude-schema'
let turn = 0
let messageNumber = 0
let claudeDefinitions
let praxisDefinitions

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function messageStart() {
  return {
    type: 'message_start',
    message: {
      id: `msg_worktree_${++messageNumber}`,
      type: 'message',
      role: 'assistant',
      model: 'fixture-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  }
}

function textEvents(text) {
  return [
    messageStart(),
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

function toolEvents(id, name, input) {
  return [
    messageStart(),
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id, name, input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]
}

function toolResult(body, id) {
  return (body.messages ?? [])
    .flatMap(({ content }) => (Array.isArray(content) ? content : []))
    .find(
      ({ type, tool_use_id }) => type === 'tool_result' && tool_use_id === id,
    )
}

function normalizeSchema(value) {
  if (Array.isArray(value)) return value.map(normalizeSchema)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'description' && key !== '$schema')
      .map(([key, child]) => [key, normalizeSchema(child)]),
  )
}

const provider = createServer(async (request, response) => {
  if (request.method === 'HEAD') {
    response.writeHead(200).end()
    return
  }
  let source = ''
  request.setEncoding('utf8')
  for await (const chunk of request) source += chunk
  const body = JSON.parse(source)
  let events
  if (mode === 'claude-schema') {
    claudeDefinitions = body.tools?.filter(({ name }) =>
      ['EnterWorktree', 'ExitWorktree'].includes(name),
    )
    events = textEvents('CLAUDE_WORKTREE_SCHEMA_DONE')
  } else if (mode === 'claude-resume') {
    events = textEvents('CLAUDE_RESUMED_PRAXIS_WORKTREE')
  } else if (turn === 0) {
    praxisDefinitions = body.tools?.filter(({ name }) =>
      ['EnterWorktree', 'ExitWorktree'].includes(name),
    )
    events = toolEvents('enter_compat', 'EnterWorktree', {
      name: 'compat-probe',
    })
    turn += 1
  } else if (turn === 1) {
    const result = toolResult(body, 'enter_compat')
    assert(
      String(result?.content).includes('/.claude/worktrees/compat-probe'),
      'Praxis EnterWorktree result differs',
    )
    events = toolEvents('pwd_compat', 'Bash', { command: 'pwd' })
    turn += 1
  } else if (turn === 2) {
    const result = toolResult(body, 'pwd_compat')
    assert(
      String(result?.content).includes('/.claude/worktrees/compat-probe'),
      `Praxis tools did not switch cwd: ${JSON.stringify(result)}`,
    )
    events = toolEvents('exit_compat', 'ExitWorktree', { action: 'remove' })
    turn += 1
  } else if (turn === 3) {
    const result = toolResult(body, 'exit_compat')
    assert(
      String(result?.content).includes('Exited and removed worktree'),
      'Praxis ExitWorktree result differs',
    )
    events = textEvents('PRAXIS_WORKTREE_DONE')
    turn += 1
  } else {
    events = textEvents('PRAXIS_WORKTREE_DONE')
  }
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
    provider.once('error', reject)
    provider.listen(0, '127.0.0.1', resolve)
  })
}

function environment(port, praxis) {
  return praxis
    ? {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_API_KEY: 'fixture-key',
        PRAXIS_MODEL: 'fixture-model',
        PRAXIS_BASE_URL: `http://127.0.0.1:${port}/v1`,
      }
    : {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      }
}

async function files(directory) {
  const output = []
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    if ((await stat(path)).isDirectory()) output.push(...(await files(path)))
    else output.push(path)
  }
  return output
}

try {
  assert(
    (await detectClaudeVersion('Worktree probe')) === '2.1.208',
    'Unsupported Claude version',
  )
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(cwd, { recursive: true }),
    listen(),
  ])
  await writeFile(join(cwd, 'tracked.txt'), 'base\n')
  await execFileAsync('git', ['init', cwd])
  await execFileAsync('git', ['-C', cwd, 'add', 'tracked.txt'])
  await execFileAsync('git', [
    '-C',
    cwd,
    '-c',
    'user.name=Praxis Test',
    '-c',
    'user.email=praxis@example.invalid',
    'commit',
    '-m',
    'fixture',
  ])
  const address = provider.address()
  if (!address || typeof address === 'string') throw new Error('no address')

  await execFileAsync(
    'claude',
    [
      '-p',
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      '1',
      '--output-format',
      'json',
      'capture worktree schema',
    ],
    {
      cwd,
      env: environment(address.port, false),
      timeout: 120_000,
    },
  )
  assert(
    claudeDefinitions?.length === 2,
    'Claude did not expose worktree tools',
  )

  mode = 'praxis'
  const praxis = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), 'dist', 'cli.js'),
      '-p',
      '--session-id',
      sessionId,
      '--tools',
      'EnterWorktree,ExitWorktree,Bash',
      '--allowedTools',
      'Bash',
      '--output-format',
      'json',
      '--',
      'run worktree compatibility',
    ],
    {
      cwd,
      env: environment(address.port, true),
      timeout: 120_000,
    },
  )
  assert(
    JSON.parse(praxis.stdout).result === 'PRAXIS_WORKTREE_DONE',
    'Praxis lifecycle failed',
  )
  assert(
    JSON.stringify(normalizeSchema(praxisDefinitions)) ===
      JSON.stringify(normalizeSchema(claudeDefinitions)),
    'Praxis worktree schemas differ from Claude',
  )

  const transcriptPath = (await files(configRoot)).find((path) =>
    path.endsWith(`/${sessionId}.jsonl`),
  )
  assert(transcriptPath, 'Praxis worktree transcript missing')
  const entries = (await readFile(transcriptPath, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
  const states = entries.filter(({ type }) => type === 'worktree-state')
  assert(
    states.length === 2 &&
      states[0].worktreeSession &&
      states[1].worktreeSession === null,
    'Praxis worktree-state sequence differs',
  )
  const enterResult = entries.find(
    ({ toolUseResult }) =>
      toolUseResult?.worktreeBranch === 'worktree-compat-probe',
  )
  const exitResult = entries.find(
    ({ toolUseResult }) => toolUseResult?.action === 'remove',
  )
  assert(enterResult && exitResult, 'Praxis native worktree results missing')

  mode = 'claude-resume'
  await execFileAsync(
    'claude',
    [
      '-p',
      '--resume',
      sessionId,
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      '1',
      '--output-format',
      'json',
      'resume Praxis worktree history',
    ],
    {
      cwd,
      env: environment(address.port, false),
      timeout: 120_000,
    },
  )

  mode = 'praxis-cli'
  const cliWorktree = join(cwd, '.claude', 'worktrees', 'cli-probe')
  await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), 'dist', 'cli.js'),
      '-p',
      '--session-id',
      cliSessionId,
      '--worktree=cli-probe',
      '--tools',
      'Read',
      '--output-format',
      'json',
      '--',
      'start in worktree',
    ],
    {
      cwd,
      env: environment(address.port, true),
      timeout: 120_000,
    },
  )
  const cliTranscriptPath = (await files(configRoot)).find((path) =>
    path.endsWith(`/${cliSessionId}.jsonl`),
  )
  assert(
    cliTranscriptPath?.includes('--claude-worktrees-cli-probe'),
    'CLI worktree transcript used wrong project identity',
  )
  const cliEntries = (await readFile(cliTranscriptPath, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
  assert(
    cliEntries[0]?.type === 'worktree-state',
    'CLI worktree-state was not first',
  )
  assert(
    cliEntries[0]?.worktreeSession?.worktreeName === 'cli-probe',
    'CLI worktree state differs',
  )

  mode = 'claude-resume'
  await execFileAsync(
    'claude',
    [
      '-p',
      '--resume',
      cliSessionId,
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      '1',
      '--output-format',
      'json',
      'resume Praxis CLI worktree history',
    ],
    {
      cwd: cliWorktree,
      env: environment(address.port, false),
      timeout: 120_000,
    },
  )
  await execFileAsync('git', [
    '-C',
    cwd,
    'worktree',
    'remove',
    '--force',
    cliWorktree,
  ])
  await execFileAsync('git', ['-C', cwd, 'branch', '-D', 'worktree-cli-probe'])
  console.log('Worktree compatibility checks passed.')
} finally {
  await new Promise((resolve) => provider.close(resolve)).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}
