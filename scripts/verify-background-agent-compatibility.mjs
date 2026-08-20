import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { detectClaudeVersion } from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-background-compat-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'work')
const sessionId = '77777777-7777-4777-8777-777777777777'
const toolNames = ['Agent', 'SendMessage', 'TaskOutput', 'TaskStop']
let mode = 'schema'
let outerTurn = 0
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
      id: `msg_background_${++messageNumber}`,
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
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(input),
      },
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

function selectedDefinitions(body) {
  return body.tools?.filter((tool) => toolNames.includes(tool.name)) ?? []
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

function lastContent(body) {
  return body.messages?.at(-1)?.content
}

function isChild(body) {
  const content = lastContent(body)
  const serialized = JSON.stringify(content)
  return (
    Array.isArray(content) &&
    !content.some((block) => block.type === 'tool_result') &&
    !serialized.includes('<task-notification>') &&
    content.some(
      (block) =>
        block.type === 'text' &&
        (block.text.includes('FIRST_CHILD_MARKER') ||
          block.text.includes('SECOND_CHILD_MARKER')),
    )
  )
}

function agentId(body) {
  return /agentId: (a[0-9a-f]{16})/u.exec(
    JSON.stringify(body.messages ?? []),
  )?.[1]
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
  if (mode === 'schema') {
    claudeDefinitions = selectedDefinitions(body)
    events = textEvents('CLAUDE_SCHEMA_DONE')
  } else if (mode === 'resume') {
    events = textEvents('CLAUDE_RESUME_DONE')
  } else if (isChild(body)) {
    const second = JSON.stringify(lastContent(body)).includes(
      'SECOND_CHILD_MARKER',
    )
    events = textEvents(second ? 'SECOND_CHILD_MARKER' : 'FIRST_CHILD_MARKER')
  } else {
    if (outerTurn === 0) praxisDefinitions = selectedDefinitions(body)
    const id = agentId(body)
    if (outerTurn === 0) {
      events = toolEvents('call_agent', 'Agent', {
        description: 'background compatibility',
        prompt: 'Return FIRST_CHILD_MARKER',
        run_in_background: true,
      })
    } else if (outerTurn === 1 && id) {
      events = toolEvents('call_output_first', 'TaskOutput', {
        task_id: id,
        block: true,
        timeout: 30000,
      })
    } else if (outerTurn === 2 && id) {
      events = toolEvents('call_message', 'SendMessage', {
        to: id,
        summary: 'continue compatibility agent',
        message: 'Return SECOND_CHILD_MARKER',
      })
    } else if (outerTurn === 3 && id) {
      events = toolEvents('call_output_second', 'TaskOutput', {
        task_id: id,
        block: true,
        timeout: 30000,
      })
    } else if (outerTurn === 4) {
      events = textEvents('PRAXIS_BACKGROUND_WAITING')
    } else {
      events = textEvents('PRAXIS_BACKGROUND_DONE')
    }
    outerTurn += 1
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

try {
  await detectClaudeVersion('Background agent probe')
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
      '--no-session-persistence',
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      '1',
      '--output-format',
      'json',
      'return schema marker',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      timeout: 120_000,
    },
  )
  assert(
    claudeDefinitions?.length === toolNames.length,
    'Claude background tool definitions are incomplete',
  )

  mode = 'praxis'
  const execution = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), 'dist', 'cli.js'),
      '-p',
      '--session-id',
      sessionId,
      '--dangerously-skip-permissions',
      '--tools',
      toolNames.join(','),
      '--output-format',
      'json',
      '--',
      'exercise background agent lifecycle',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_API_KEY: 'fixture-key',
        PRAXIS_MODEL: 'fixture-model',
        PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      },
      timeout: 120_000,
    },
  )
  const result = JSON.parse(execution.stdout)
  assert(
    result.type === 'result' &&
      result.is_error === false &&
      result.result === 'PRAXIS_BACKGROUND_DONE' &&
      result.session_id === sessionId,
    `Praxis background run failed: ${execution.stdout}`,
  )
  assert(
    JSON.stringify(normalizeSchema(praxisDefinitions)) ===
      JSON.stringify(normalizeSchema(claudeDefinitions)),
    'Praxis background tool schemas differ from Claude',
  )

  const projectDirectory = (await readdir(join(configRoot, 'projects')))[0]
  assert(projectDirectory, 'Praxis project directory missing')
  const projectRoot = join(configRoot, 'projects', projectDirectory)
  const transcript = await readFile(
    join(projectRoot, `${sessionId}.jsonl`),
    'utf8',
  )
  assert(
    transcript.includes('"status":"async_launched"') &&
      transcript.includes('FIRST_CHILD_MARKER') &&
      transcript.includes('SECOND_CHILD_MARKER') &&
      transcript.includes('<task-notification>'),
    `Praxis background transcript is incomplete: ${JSON.stringify({ async: transcript.includes('"status":"async_launched"'), first: transcript.includes('FIRST_CHILD_MARKER'), second: transcript.includes('SECOND_CHILD_MARKER'), notification: transcript.includes('<task-notification>') })}`,
  )
  const subagentDirectory = join(projectRoot, sessionId, 'subagents')
  const sidechainName = (await readdir(subagentDirectory)).find((name) =>
    name.endsWith('.jsonl'),
  )
  assert(
    /^agent-a[0-9a-f]{16}\.jsonl$/u.test(sidechainName ?? ''),
    `Praxis background sidechain name changed: ${sidechainName}`,
  )
  const sidechain = await readFile(
    join(subagentDirectory, sidechainName),
    'utf8',
  )
  assert(
    sidechain.includes('FIRST_CHILD_MARKER') &&
      sidechain.includes('SECOND_CHILD_MARKER') &&
      sidechain.includes('The coordinator sent a message'),
    'Praxis background sidechain continuation is incomplete',
  )

  mode = 'resume'
  const resumed = await execFileAsync(
    'claude',
    [
      '-p',
      '--resume',
      sessionId,
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--output-format',
      'json',
      'resume background session',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      timeout: 120_000,
    },
  )
  const resumeResult = JSON.parse(resumed.stdout)
  assert(
    resumeResult.type === 'result' &&
      resumeResult.is_error === false &&
      resumeResult.session_id === sessionId &&
      resumeResult.result === 'CLAUDE_RESUME_DONE',
    `Claude could not resume Praxis background session: ${resumed.stdout}`,
  )

  console.log(
    `Claude background agent compatibility passed: schemas, async launch, output polling, same-ID messaging, completion notification, sidechain persistence, and Claude resume`,
  )
} finally {
  await closeProvider().catch(() => undefined)
  await rm(root, { recursive: true })
}
