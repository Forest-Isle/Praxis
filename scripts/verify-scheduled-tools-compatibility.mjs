import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { detectClaudeVersion } from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-scheduled-compat-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'work')
const sessionId = '22222222-2222-4222-8222-222222222222'
const toolNames = ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup']
let mode = 'schema'
let turn = 0
let messageNumber = 0
let claudeDefinitions
let praxisDefinitions
const results = { praxis: [], claude: [], resumed: [] }

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function messageStart() {
  return {
    type: 'message_start',
    message: {
      id: `msg_scheduled_${++messageNumber}`,
      type: 'message',
      role: 'assistant',
      model: 'fixture-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 0 },
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

function normalizeSchema(value) {
  if (Array.isArray(value)) return value.map(normalizeSchema)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'description' && key !== '$schema')
      .map(([key, child]) => [key, normalizeSchema(child)]),
  )
}

function selectedDefinitions(body) {
  return body.tools?.filter(({ name }) => toolNames.includes(name)) ?? []
}

function definition(definitions, name) {
  return definitions?.find((candidate) => candidate.name === name)
}

function lastToolResult(body) {
  const content = body.messages?.at(-1)?.content
  if (!Array.isArray(content)) return null
  return content.find(({ type }) => type === 'tool_result') ?? null
}

function latestJobId(body) {
  const matches = [
    ...JSON.stringify(body.messages ?? []).matchAll(
      /(?:Scheduled recurring job|Cancelled job) ([0-9a-f]{8})/gu,
    ),
  ]
  return matches.at(-1)?.[1]
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
  const definitions = selectedDefinitions(body)
  const result = lastToolResult(body)
  if (result && mode in results) results[mode].push(result)
  let events
  if (mode === 'schema') {
    if (definitions.length > 0) claudeDefinitions = definitions
    events = textEvents('CLAUDE_SCHEDULED_SCHEMA_DONE')
  } else if (mode === 'praxis') {
    if (turn === 0) {
      praxisDefinitions = definitions
      events = toolEvents('praxis_create', 'CronCreate', {
        cron: '17 9 * * 1-5',
        prompt: 'Praxis scheduled prompt',
        recurring: true,
        durable: true,
      })
    } else if (turn === 1) events = toolEvents('praxis_list', 'CronList', {})
    else if (turn === 2) {
      events = toolEvents('praxis_wakeup', 'ScheduleWakeup', {
        delaySeconds: 1,
        reason: 'probe inactive gate',
        prompt: 'continue probe',
      })
    } else events = textEvents('PRAXIS_SCHEDULED_DONE')
    turn += 1
  } else if (mode === 'claude') {
    if (turn === 0) events = toolEvents('claude_list', 'CronList', {})
    else if (turn === 1) {
      const id = latestJobId(body)
      assert(id, 'Claude could not find Praxis cron ID')
      events = toolEvents('claude_delete', 'CronDelete', { id })
    } else if (turn === 2) {
      events = toolEvents('claude_create', 'CronCreate', {
        cron: '19 9 * * 1-5',
        prompt: 'Claude scheduled prompt',
        recurring: true,
        durable: true,
      })
    } else events = textEvents('CLAUDE_SCHEDULED_DONE')
    turn += 1
  } else {
    if (turn === 0) events = toolEvents('praxis_list_again', 'CronList', {})
    else if (turn === 1) {
      const id = latestJobId(body)
      assert(id, 'Praxis could not find Claude cron ID')
      events = toolEvents('praxis_delete', 'CronDelete', { id })
    } else events = textEvents('PRAXIS_SCHEDULED_RESUME_DONE')
    turn += 1
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

function closeProvider() {
  return new Promise((resolve, reject) =>
    provider.close((error) => (error ? reject(error) : resolve())),
  )
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

async function runPraxis(args, port) {
  return execFileAsync(
    process.execPath,
    [join(process.cwd(), 'dist', 'cli.js'), '-p', ...args],
    { cwd, env: environment(port, true), timeout: 120_000 },
  )
}

async function verifyActivePraxisWakeup() {
  const [{ ScheduledPromptManager }, { ClaudeScheduledToolRegistry }] =
    await Promise.all([
      import('../dist/application/scheduled-prompt-manager.js'),
      import('../dist/tools/claude-scheduled-tools.js'),
    ])
  const now = () => Date.UTC(2026, 7, 5, 14, 0, 0)
  const manager = new ScheduledPromptManager({
    filePath: join(cwd, '.claude', 'scheduled_tasks.json'),
    lockFile: join(configRoot, 'praxis', 'locks', 'active-wakeup.lock'),
    dynamicWakeupsEnabled: true,
    now,
  })
  const base = {
    definitions: () => [],
    prepare: async (call) => call,
    execute: async () => ({ content: '', isError: false }),
  }
  const registry = new ClaudeScheduledToolRegistry({
    base,
    manager,
    sessionId,
    now,
  })
  const context = { cwd }
  const execute = async (id, input) => {
    const call = await registry.prepare(
      { id, name: 'ScheduleWakeup', input },
      context,
    )
    return registry.execute(call, context)
  }
  const first = await execute('active-one', {
    delaySeconds: 1,
    reason: 'probe active contract',
    prompt: 'continue active probe',
  })
  const scheduledFor = Date.UTC(2026, 7, 5, 14, 1, 0)
  const scheduledTime = new Date(scheduledFor).toTimeString().slice(0, 8)
  assert(
    first.content ===
      `Next wakeup scheduled for ${scheduledTime} (in 60s) (clamped to 60s from your requested value). Nothing more to do this turn — the harness re-invokes you when the wakeup fires or a task-notification arrives.`,
    `Praxis active wakeup result changed: ${first.content}`,
  )
  assert(
    JSON.stringify(first.nativeToolUseResult) ===
      JSON.stringify({
        stopped: false,
        nextWakeupMs: scheduledFor,
        delaySeconds: 60,
        reason: 'probe active contract',
      }),
    'Praxis active wakeup native result changed',
  )
  await execute('active-replacement', {
    delaySeconds: 120,
    reason: 'replace active wakeup',
    prompt: 'continue active probe',
  })
  const stopped = await execute('active-stop', { stop: true })
  assert(
    stopped.nativeToolUseResult?.stopped === true &&
      stopped.nativeToolUseResult?.nextWakeupMs === 0 &&
      stopped.nativeToolUseResult?.delaySeconds === 0 &&
      stopped.nativeToolUseResult?.reason === '' &&
      String(stopped.content).includes('cancelled 1 pending wakeup(s)'),
    'Praxis did not supersede the previous active wakeup',
  )
  manager.close()
  return true
}

try {
  const version = await detectClaudeVersion('Scheduled tools probe')
  assert(version === '2.1.208', `Unsupported Claude version ${version}`)
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(cwd, { recursive: true }),
    listen(),
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
      'return scheduled schema marker',
    ],
    { cwd, env: environment(address.port, false), timeout: 120_000 },
  )
  assert(
    claudeDefinitions?.length === toolNames.length,
    'Claude scheduled definitions are incomplete',
  )

  mode = 'praxis'
  turn = 0
  const created = await runPraxis(
    [
      '--session-id',
      sessionId,
      '--dangerously-skip-permissions',
      '--tools',
      toolNames.join(','),
      '--output-format',
      'json',
      '--',
      'create scheduled compatibility job',
    ],
    address.port,
  )
  assert(
    JSON.parse(created.stdout).result === 'PRAXIS_SCHEDULED_DONE',
    `Praxis scheduled lifecycle failed: ${created.stdout}`,
  )
  assert(
    JSON.stringify(normalizeSchema(praxisDefinitions)) ===
      JSON.stringify(normalizeSchema(claudeDefinitions)),
    'Praxis scheduled schemas differ from Claude',
  )
  const claudeWakeup = definition(claudeDefinitions, 'ScheduleWakeup')
  const praxisWakeup = definition(praxisDefinitions, 'ScheduleWakeup')
  assert(
    praxisWakeup?.description === claudeWakeup?.description,
    'Praxis ScheduleWakeup description differs from Claude',
  )
  assert(
    JSON.stringify(praxisWakeup?.input_schema) ===
      JSON.stringify(claudeWakeup?.input_schema),
    'Praxis ScheduleWakeup input schema descriptions differ from Claude',
  )
  const nativeFile = JSON.parse(
    await readFile(join(cwd, '.claude', 'scheduled_tasks.json'), 'utf8'),
  )
  assert(
    nativeFile.tasks.length === 1 &&
      nativeFile.tasks[0].prompt === 'Praxis scheduled prompt' &&
      !('durable' in nativeFile.tasks[0]),
    'Praxis did not write the Claude scheduled task layout',
  )

  mode = 'claude'
  turn = 0
  const claude = await execFileAsync(
    'claude',
    [
      '-p',
      '--resume',
      sessionId,
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      '6',
      '--dangerously-skip-permissions',
      '--output-format',
      'json',
      'read and replace Praxis scheduled job',
    ],
    { cwd, env: environment(address.port, false), timeout: 120_000 },
  )
  assert(
    JSON.parse(claude.stdout).result === 'CLAUDE_SCHEDULED_DONE',
    `Claude could not use Praxis scheduled state: ${claude.stdout}`,
  )
  assert(
    results.claude.some(({ content }) =>
      String(content).includes('Praxis scheduled prompt'),
    ),
    'Claude did not list the Praxis-created job',
  )

  mode = 'resumed'
  turn = 0
  const resumed = await runPraxis(
    [
      '--resume',
      sessionId,
      '--dangerously-skip-permissions',
      '--tools',
      toolNames.join(','),
      '--output-format',
      'json',
      '--',
      'read and delete Claude scheduled job',
    ],
    address.port,
  )
  assert(
    JSON.parse(resumed.stdout).result === 'PRAXIS_SCHEDULED_RESUME_DONE',
    `Praxis could not resume Claude scheduled state: ${resumed.stdout}`,
  )
  assert(
    results.resumed.some(({ content }) =>
      String(content).includes('Claude scheduled prompt'),
    ),
    'Praxis did not list the Claude-created job',
  )
  const finalFile = JSON.parse(
    await readFile(join(cwd, '.claude', 'scheduled_tasks.json'), 'utf8'),
  )
  assert(finalFile.tasks.length === 0, 'Scheduled job cleanup failed')
  const activeWakeupContract = await verifyActivePraxisWakeup()

  console.log(
    JSON.stringify(
      {
        version,
        schemas: true,
        nativeLayout: true,
        claudeReadsPraxis: true,
        praxisReadsClaude: true,
        bidirectionalResume: true,
        inactiveWakeupGate: results.praxis.some(({ content }) =>
          String(content).includes('Wakeup not scheduled'),
        ),
        activeWakeupContract,
      },
      null,
      2,
    ),
  )
} finally {
  await closeProvider().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}
