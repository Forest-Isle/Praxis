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
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { detectClaudeVersion } from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-compat-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'work')
const sessionId = '33333333-3333-4333-8333-333333333333'
const deniedSessionId = '44444444-4444-4444-8444-444444444444'
let mode = 'claude-schema'
let outerTurn = 0
let messageNumber = 0
let claudeDefinition
let praxisDefinition
let childRequests = 0
let deniedResult
let effortRequest

const workflowScript = `export const meta = {
  name: 'compat-probe',
  description: 'Verify Praxis workflow compatibility',
  phases: [{ title: 'Agent', detail: 'Run structured probe agent' }],
}
phase('Agent')
const answer = await agent('WORKFLOW_CHILD_MARKER', {
  label: 'probe-agent',
  phase: 'Agent',
  effort: 'low',
  schema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
})
return { marker: 'PRAXIS_WORKFLOW_RESULT', answer }`

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function messageStart() {
  return {
    type: 'message_start',
    message: {
      id: `msg_workflow_${++messageNumber}`,
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

function toolResult(body, id) {
  return (body.messages ?? [])
    .flatMap(({ content }) => (Array.isArray(content) ? content : []))
    .find(
      ({ type, tool_use_id }) => type === 'tool_result' && tool_use_id === id,
    )
}

function workflowResume(body) {
  const source = String(toolResult(body, 'workflow_launch')?.content ?? '')
  const scriptPath = /Script file: ([^\n]+)/u.exec(source)?.[1]
  const runId = /Run ID: (wf_[a-z0-9-]+)/u.exec(source)?.[1]
  assert(scriptPath && runId, 'Could not parse Praxis workflow launch result')
  return { scriptPath, resumeFromRunId: runId }
}

async function replaceReplayKey({ scriptPath, resumeFromRunId }) {
  const sessionDirectory = dirname(dirname(dirname(scriptPath)))
  const journalFile = join(
    sessionDirectory,
    'subagents',
    'workflows',
    resumeFromRunId,
    'journal.jsonl',
  )
  const journal = (await readFile(journalFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => ({ ...JSON.parse(line), key: 'v2:foreign-key' }))
  await writeFile(
    journalFile,
    `${journal.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  )
}

function isChild(body) {
  return (
    JSON.stringify(body.messages ?? []).includes('WORKFLOW_CHILD_MARKER') &&
    !body.tools?.some(({ name }) => name === 'Workflow')
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
    claudeDefinition = body.tools?.find(({ name }) => name === 'Workflow')
    events = textEvents('CLAUDE_WORKFLOW_SCHEMA_DONE')
  } else if (mode === 'claude-resume') {
    events = textEvents('CLAUDE_READ_PRAXIS_WORKFLOW_DONE')
  } else if (mode === 'denied') {
    if (outerTurn === 0) {
      praxisDefinition = body.tools?.find(({ name }) => name === 'Workflow')
      events = toolEvents('workflow_denied', 'Workflow', {
        script: `export const meta = { name: 'denied', description: 'Denied workflow' }\nreturn 1`,
      })
    } else {
      deniedResult = toolResult(body, 'workflow_denied')
      events = textEvents('PRAXIS_WORKFLOW_DENIED_DONE')
    }
    outerTurn += 1
  } else if (isChild(body)) {
    childRequests += 1
    effortRequest = body.output_config
    const childToolNames = body.tools?.map(({ name }) => name) ?? []
    assert(
      JSON.stringify(childToolNames) === JSON.stringify(['StructuredOutput']),
      `Structured workflow exposed unexpected tools: ${JSON.stringify(childToolNames)}`,
    )
    const structured = true
    const completed = toolResult(body, 'structured_result')
    events =
      structured && !completed
        ? toolEvents('structured_result', 'StructuredOutput', {
            value: 'STRUCTURED_WORKFLOW_VALUE',
          })
        : textEvents('WORKFLOW_CHILD_COMPLETE')
  } else if (outerTurn === 0) {
    praxisDefinition = body.tools?.find(({ name }) => name === 'Workflow')
    events = toolEvents('workflow_launch', 'Workflow', {
      script: workflowScript,
      args: { probe: 23 },
    })
    outerTurn += 1
  } else if (outerTurn === 1) {
    events = textEvents('PRAXIS_WORKFLOW_WAITING')
    outerTurn += 1
  } else if (outerTurn === 2) {
    assert(
      JSON.stringify(body.messages ?? []).includes('<task-notification>'),
      'Praxis did not inject workflow completion notification',
    )
    const resume = workflowResume(body)
    await replaceReplayKey(resume)
    events = toolEvents('workflow_resume', 'Workflow', resume)
    outerTurn += 1
  } else if (outerTurn === 3) {
    events = textEvents('PRAXIS_WORKFLOW_RESUME_WAITING')
    outerTurn += 1
  } else {
    assert(
      JSON.stringify(body.messages ?? []).includes('<task-notification>'),
      'Praxis did not inject resumed workflow notification',
    )
    events = textEvents('PRAXIS_WORKFLOW_DONE')
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

async function files(directory) {
  const result = []
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const metadata = await stat(path)
    if (metadata.isDirectory()) result.push(...(await files(path)))
    else result.push(path)
  }
  return result
}

try {
  const version = await detectClaudeVersion('Workflow probe')
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
      'return workflow schema marker',
    ],
    { cwd, env: environment(address.port, false), timeout: 120_000 },
  )
  assert(claudeDefinition, 'Claude did not expose Workflow')

  mode = 'denied'
  outerTurn = 0
  const beforeDenied = (await files(configRoot)).filter((path) =>
    /\/workflows\/wf_[^/]+\.json$/u.test(path),
  ).length
  await runPraxis(
    [
      '--session-id',
      deniedSessionId,
      '--tools',
      'Workflow,TaskOutput,TaskStop',
      '--output-format',
      'json',
      '--',
      'attempt denied workflow',
    ],
    address.port,
  )
  assert(
    deniedResult?.content === 'Review dynamic workflow before running',
    `Unexpected Workflow denial: ${JSON.stringify(deniedResult)}`,
  )
  const afterDenied = (await files(configRoot)).filter((path) =>
    /\/workflows\/wf_[^/]+\.json$/u.test(path),
  ).length
  assert(beforeDenied === afterDenied, 'Denied Workflow created run artifacts')

  mode = 'praxis'
  outerTurn = 0
  childRequests = 0
  const praxis = await runPraxis(
    [
      '--session-id',
      sessionId,
      '--dangerously-skip-permissions',
      '--tools',
      'Workflow,TaskOutput,TaskStop',
      '--output-format',
      'json',
      '--',
      'run workflow compatibility probe',
    ],
    address.port,
  )
  assert(
    JSON.parse(praxis.stdout).result === 'PRAXIS_WORKFLOW_DONE',
    `Praxis workflow lifecycle failed: ${praxis.stdout}`,
  )
  assert(
    childRequests === 2,
    `Workflow replay made extra provider calls: ${childRequests}`,
  )
  assert(
    JSON.stringify(effortRequest) === JSON.stringify({ effort: 'low' }),
    `Workflow effort was not forwarded: ${JSON.stringify(effortRequest)}`,
  )
  assert(
    JSON.stringify(normalizeSchema(praxisDefinition)) ===
      JSON.stringify(normalizeSchema(claudeDefinition)),
    'Praxis Workflow schema differs from Claude',
  )

  const allFiles = await files(configRoot)
  const runFile = allFiles.find((path) =>
    new RegExp(`/${sessionId}/workflows/wf_[^/]+\\.json$`, 'u').test(path),
  )
  const journalFile = allFiles.find((path) =>
    new RegExp(
      `/${sessionId}/subagents/workflows/wf_[^/]+/journal\\.jsonl$`,
      'u',
    ).test(path),
  )
  const metadataFile = allFiles.find((path) =>
    new RegExp(
      `/${sessionId}/subagents/workflows/wf_[^/]+/agent-a[0-9a-f]{16}\\.meta\\.json$`,
      'u',
    ).test(path),
  )
  const replayMetadataFile = allFiles.find((path) =>
    new RegExp(
      `/${sessionId}/subagents/workflows/wf_[^/]+/\\.praxis-replay-metadata\\.jsonl$`,
      'u',
    ).test(path),
  )
  assert(
    runFile && journalFile && metadataFile && replayMetadataFile,
    'Workflow artifacts are incomplete',
  )
  const run = JSON.parse(await readFile(runFile, 'utf8'))
  assert(run.status === 'completed', 'Workflow run did not complete')
  assert(
    run.result?.answer?.value === 'STRUCTURED_WORKFLOW_VALUE',
    'Structured result was not persisted',
  )
  assert(
    run.totalTokens === 0,
    `Resumed workflow was not zero-token: ${run.totalTokens}`,
  )
  assert(
    run.workflowProgress?.some(({ cached }) => cached === true),
    'Resumed workflow progress did not mark its replay hit',
  )
  const journal = (await readFile(journalFile, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
  assert(
    journal.length === 2 && journal[1]?.result?.value,
    'Workflow journal is invalid',
  )
  const replayMetadata = (await readFile(replayMetadataFile, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
  assert(
    replayMetadata.length === 1 &&
      replayMetadata[0]?.prompt === 'WORKFLOW_CHILD_MARKER' &&
      replayMetadata[0]?.options?.effort === 'low' &&
      replayMetadata[0]?.options?.schema?.type === 'object',
    'Workflow semantic replay metadata is invalid',
  )
  assert(
    JSON.stringify(JSON.parse(await readFile(metadataFile, 'utf8'))) ===
      JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }),
    'Workflow agent metadata differs from Claude',
  )

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
      'read Praxis workflow history',
    ],
    { cwd, env: environment(address.port, false), timeout: 120_000 },
  )
  console.log('Workflow compatibility checks passed.')
} finally {
  await closeProvider().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}
