import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { detectClaudeVersion } from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-task-compat-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'work')
const sessionId = '20202020-2020-4020-8020-202020202020'
const toolNames = [
  'Bash',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
]
let mode = 'schema'
let turn = 0
let messageNumber = 0
let claudeDefinitions
let praxisDefinitions
let bashOnlyDefinitions
const results = { praxis: [], claude: [], resumed: [] }

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function messageStart() {
  return {
    type: 'message_start',
    message: {
      id: `msg_task_${++messageNumber}`,
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

function lastToolResult(body) {
  const content = body.messages?.at(-1)?.content
  if (!Array.isArray(content)) return null
  return content.find(({ type }) => type === 'tool_result') ?? null
}

function latestBackgroundId(body) {
  const matches = [
    ...JSON.stringify(body.messages ?? []).matchAll(
      /background with ID: (b[a-z0-9]{8})/gu,
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
  const result = lastToolResult(body)
  if (result && mode in results) results[mode].push(result)
  let events
  if (mode === 'schema') {
    claudeDefinitions = selectedDefinitions(body)
    events = textEvents('CLAUDE_TASK_SCHEMA_DONE')
  } else if (mode === 'bash-only') {
    bashOnlyDefinitions = selectedDefinitions(body)
    events = textEvents('PRAXIS_BASH_ONLY_DONE')
  } else if (mode === 'praxis') {
    if (turn === 0) {
      praxisDefinitions = selectedDefinitions(body)
      events = toolEvents('create_first', 'TaskCreate', {
        subject: 'Praxis first task',
        description: 'Created by Praxis',
        metadata: { creator: 'praxis' },
      })
    } else if (turn === 1) {
      events = toolEvents('create_second', 'TaskCreate', {
        subject: 'Praxis second task',
        description: 'Blocked task',
      })
    } else if (turn === 2) {
      events = toolEvents('block_second', 'TaskUpdate', {
        taskId: '2',
        owner: 'praxis-worker',
        addBlockedBy: ['1'],
      })
    } else if (turn === 3) {
      events = toolEvents('background_bash', 'Bash', {
        command:
          "printf 'TASK_BG_START\\n'; sleep 0.05; printf 'TASK_BG_END\\n'",
        description: 'Emit task compatibility markers',
        run_in_background: true,
      })
    } else if (turn === 4) {
      const id = latestBackgroundId(body)
      assert(
        id,
        `Praxis background Bash ID missing: ${JSON.stringify(body.messages?.at(-1))}`,
      )
      events = toolEvents('background_output', 'TaskOutput', {
        task_id: id,
        block: true,
        timeout: 30000,
      })
    } else if (turn === 5) {
      events = toolEvents('background_notify<&"', 'Bash', {
        command: "printf 'TASK_BG_NOTIFY\\n'",
        description: 'Emit <unpolled> & notification',
        run_in_background: true,
      })
    } else if (turn === 6) {
      events = textEvents('PRAXIS_TASK_WAITING')
    } else {
      events = textEvents('PRAXIS_TASK_DONE')
    }
    turn += 1
  } else if (mode === 'claude') {
    if (turn === 0) events = toolEvents('claude_list', 'TaskList', {})
    else if (turn === 1) {
      events = toolEvents('claude_create', 'TaskCreate', {
        subject: 'Claude third task',
        description: 'Created by Claude resume',
        metadata: { creator: 'claude' },
      })
    } else if (turn === 2) {
      events = toolEvents('claude_create_internal', 'TaskCreate', {
        subject: 'Claude internal task',
        description: 'Hidden from TaskList',
        metadata: { _internal: true, creator: 'claude' },
      })
    } else if (turn === 3) {
      events = toolEvents('claude_complete_first', 'TaskUpdate', {
        taskId: '1',
        status: 'completed',
      })
    } else events = textEvents('CLAUDE_TASK_DONE')
    turn += 1
  } else {
    if (turn === 0) events = toolEvents('praxis_list_again', 'TaskList', {})
    else if (turn === 1) {
      events = toolEvents('praxis_get_third', 'TaskGet', { taskId: '3' })
    } else if (turn === 2) {
      events = toolEvents('praxis_complete_third', 'TaskUpdate', {
        taskId: '3',
        status: 'completed',
        metadata: { verifiedBy: 'praxis' },
      })
    } else if (turn === 3) {
      events = toolEvents('praxis_create_fifth', 'TaskCreate', {
        subject: 'Praxis fifth task',
        description: 'Repair shared highwatermark',
      })
    } else events = textEvents('PRAXIS_RESUME_TASK_DONE')
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
  return new Promise((resolveListen, reject) => {
    provider.once('error', reject)
    provider.listen(0, '127.0.0.1', resolveListen)
  })
}

function closeProvider() {
  return new Promise((resolveClose, reject) =>
    provider.close((error) => (error ? reject(error) : resolveClose())),
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

try {
  await detectClaudeVersion('Durable task probe')
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
      'return durable task schema marker',
    ],
    { cwd, env: environment(address.port, false), timeout: 120_000 },
  )
  assert(
    claudeDefinitions?.length === toolNames.length,
    'Claude durable task definitions are incomplete',
  )

  mode = 'bash-only'
  const bashOnly = await runPraxis(
    [
      '--session-id',
      '30303030-3030-4030-8030-303030303030',
      '--dangerously-skip-permissions',
      '--tools',
      'Bash',
      '--output-format',
      'json',
      '--',
      'inspect Bash schema',
    ],
    address.port,
  )
  const bashOnlyResult = JSON.parse(bashOnly.stdout)
  assert(
    bashOnlyResult.result === 'PRAXIS_BASH_ONLY_DONE' &&
      bashOnlyDefinitions?.length === 1 &&
      bashOnlyDefinitions[0]?.name === 'Bash' &&
      bashOnlyDefinitions[0]?.input_schema?.properties?.run_in_background,
    `Praxis Bash-only background schema missing: ${bashOnly.stdout}`,
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
      'create durable task compatibility graph',
    ],
    address.port,
  )
  const createdResult = JSON.parse(created.stdout)
  assert(
    createdResult.result === 'PRAXIS_TASK_DONE' &&
      createdResult.session_id === sessionId,
    `Praxis task lifecycle failed: ${created.stdout}`,
  )
  assert(
    JSON.stringify(normalizeSchema(praxisDefinitions)) ===
      JSON.stringify(normalizeSchema(claudeDefinitions)),
    'Praxis durable task schemas differ from Claude',
  )
  assert(
    results.praxis.some(({ content }) =>
      String(content).includes('<status>completed</status>'),
    ),
    'Praxis background Bash output is incomplete',
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
      '8',
      '--dangerously-skip-permissions',
      '--output-format',
      'json',
      'read and extend Praxis durable tasks',
    ],
    { cwd, env: environment(address.port, false), timeout: 120_000 },
  )
  const claudeResult = JSON.parse(claude.stdout)
  assert(
    claudeResult.result === 'CLAUDE_TASK_DONE' &&
      claudeResult.session_id === sessionId,
    `Claude could not use Praxis tasks: ${claude.stdout}`,
  )
  assert(
    results.claude.some(({ content }) =>
      String(content).includes('Praxis second task'),
    ),
    'Claude did not list Praxis-created tasks',
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
      'read and complete Claude durable task',
    ],
    address.port,
  )
  const resumedResult = JSON.parse(resumed.stdout)
  assert(
    resumedResult.result === 'PRAXIS_RESUME_TASK_DONE',
    `Praxis could not resume Claude tasks: ${resumed.stdout}`,
  )
  assert(
    results.resumed.some(({ content }) =>
      String(content).includes('Claude third task'),
    ),
    'Praxis did not read Claude-created task',
  )
  assert(
    results.resumed.every(
      ({ content }) => !String(content).includes('Claude internal task'),
    ),
    'Praxis exposed Claude internal task through TaskList',
  )

  const taskRoot = join(configRoot, 'tasks', sessionId)
  const highwatermark = await readFile(join(taskRoot, '.highwatermark'), 'utf8')
  const taskNames = (await readdir(taskRoot)).filter((name) =>
    name.endsWith('.json'),
  )
  assert(
    highwatermark === '5',
    `Unexpected durable task highwatermark: ${JSON.stringify({ highwatermark, taskNames, resumed: results.resumed })}`,
  )
  assert(taskNames.length === 5, `Unexpected durable task files: ${taskNames}`)
  const third = JSON.parse(await readFile(join(taskRoot, '3.json'), 'utf8'))
  assert(
    third.subject === 'Claude third task' &&
      third.status === 'completed' &&
      third.metadata.creator === 'claude' &&
      third.metadata.verifiedBy === 'praxis',
    `Cross-runtime task update changed: ${JSON.stringify(third)}`,
  )

  const projectDirectory = (await readdir(join(configRoot, 'projects')))[0]
  const transcript = await readFile(
    join(configRoot, 'projects', projectDirectory, `${sessionId}.jsonl`),
    'utf8',
  )
  assert(
    transcript.includes('"backgroundTaskId"') &&
      transcript.includes('"retrieval_status":"success"') &&
      transcript.includes('<task-notification>') &&
      transcript.includes('Emit &lt;unpolled&gt; &amp; notification') &&
      transcript.includes('background_notify&lt;&amp;&quot;') &&
      transcript.includes('"taskId":"3"'),
    'Praxis task transcript native metadata is incomplete',
  )

  console.log(
    `Claude durable task compatibility passed: schemas, shared graph, background Bash, native results, notifications, and bidirectional resume`,
  )
} finally {
  await closeProvider().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}
