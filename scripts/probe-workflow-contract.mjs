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

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-probe-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'work')
let captured
const mode = process.env.PRAXIS_WORKFLOW_PROBE_MODE ?? 'schema'
const keepRoot = process.env.PRAXIS_WORKFLOW_PROBE_KEEP_ROOT === '1'
const prompt = process.env.PRAXIS_WORKFLOW_PROBE_PROMPT
const workflowInput = process.env.PRAXIS_WORKFLOW_INPUT
  ? JSON.parse(process.env.PRAXIS_WORKFLOW_INPUT)
  : null
const isWorkflowRun = [
  'lifecycle',
  'agent',
  'resume',
  'permission',
  'named',
  'error',
  'structured',
  'task-output',
  'stop',
  'status-stop',
  'failure',
].includes(mode)
let turn = 0
const requests = []

function events(text) {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_workflow_probe',
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

function toolEvents(id, name, input) {
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_workflow_tool_${turn}`,
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

const provider = createServer(async (request, response) => {
  if (request.method === 'HEAD') {
    response.writeHead(200).end()
    return
  }
  let source = ''
  request.setEncoding('utf8')
  for await (const chunk of request) source += chunk
  captured = JSON.parse(source)
  requests.push({
    model: captured.model,
    thinking: captured.thinking,
    output_config: captured.output_config,
    tools: captured.tools?.map(({ name }) => name),
    definitions: captured.tools?.filter(({ name }) =>
      ['Workflow', 'StructuredOutput'].includes(name),
    ),
    messages: captured.messages,
  })
  if (
    (mode === 'stop' || mode === 'status-stop') &&
    !captured.tools?.some(({ name }) => name === 'Workflow')
  ) {
    request.resume()
    return
  }
  const script =
    process.env.PRAXIS_WORKFLOW_SCRIPT ??
    (['agent', 'resume', 'task-output', 'stop', 'status-stop'].includes(mode)
      ? `export const meta = {
  name: 'stage23-agent-probe',
  description: 'Probe workflow agent persistence',
  phases: [{ title: 'Agent', detail: 'run one deterministic agent' }],
}
phase('Agent')
const answer = await agent('Return the workflow agent marker.', { label: 'probe-agent' })
return { marker: 'WORKFLOW_AGENT_RESULT', answer }`
      : mode === 'structured'
        ? `export const meta = {
  name: 'stage23-structured-probe',
  description: 'Probe structured workflow agent result',
}
const schema = {
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
  additionalProperties: false,
}
const answer = await agent('Return a structured workflow marker.', { schema })
return { marker: 'WORKFLOW_STRUCTURED_RESULT', answer }`
        : mode === 'failure'
          ? `export const meta = {
  name: 'stage23-failure-probe',
  description: 'Probe workflow failure state',
}
throw new Error('WORKFLOW_FAILURE_MARKER')`
          : `export const meta = {
  name: 'stage23-probe',
  description: 'Probe minimal workflow lifecycle',
  phases: [{ title: 'Complete', detail: 'return deterministic marker' }],
}
phase('Complete')
log('workflow lifecycle marker')
return { marker: 'WORKFLOW_RESULT_MARKER', args }`)
  const workflowUses = (captured.messages ?? [])
    .flatMap(({ content }) => (Array.isArray(content) ? content : []))
    .filter(({ type, name }) => type === 'tool_use' && name === 'Workflow')
  const notifications = JSON.stringify(captured.messages ?? []).match(
    /<task-notification>/gu,
  )
  const firstResult = (captured.messages ?? [])
    .flatMap(({ content }) => (Array.isArray(content) ? content : []))
    .find(
      ({ type, tool_use_id }) =>
        type === 'tool_result' && tool_use_id === 'workflow_probe_call',
    )
  const resultText = String(firstResult?.content ?? '')
  const scriptPath = /Script file: ([^\n]+)/u.exec(resultText)?.[1]
  const runId = /Run ID: (wf_[a-z0-9-]+)/u.exec(resultText)?.[1]
  const taskId = /Task ID: (w[a-z0-9]{8})/u.exec(resultText)?.[1]
  const taskOutputUses = (captured.messages ?? [])
    .flatMap(({ content }) => (Array.isArray(content) ? content : []))
    .filter(
      ({ type, name }) =>
        type === 'tool_use' && (name === 'TaskOutput' || name === 'TaskStop'),
    )
  let responseEvents
  const structuredOutput = captured.tools?.some(
    ({ name }) => name === 'StructuredOutput',
  )
  const structuredResult = (captured.messages ?? [])
    .flatMap(({ content }) => (Array.isArray(content) ? content : []))
    .some(
      ({ type, tool_use_id }) =>
        type === 'tool_result' && tool_use_id === 'workflow_structured_call',
    )
  if (structuredOutput && !structuredResult) {
    responseEvents = toolEvents(
      'workflow_structured_call',
      'StructuredOutput',
      { value: 'STRUCTURED_WORKFLOW_VALUE' },
    )
  } else if (mode === 'wakeup' && turn === 0) {
    responseEvents = toolEvents('workflow_wakeup_call', 'ScheduleWakeup', {
      delaySeconds: 60,
      reason: 'probe active dynamic gate',
      prompt:
        typeof workflowInput?.prompt === 'string'
          ? workflowInput.prompt
          : 'check build',
    })
  } else if (
    (mode === 'task-output' || mode === 'stop' || mode === 'status-stop') &&
    workflowUses.length === 1 &&
    taskOutputUses.length === 0 &&
    taskId
  ) {
    responseEvents = toolEvents(
      mode === 'stop' ? 'workflow_stop_call' : 'workflow_output_call',
      mode === 'stop' ? 'TaskStop' : 'TaskOutput',
      mode === 'stop'
        ? { task_id: taskId }
        : {
            task_id: taskId,
            block: mode === 'task-output',
            timeout: mode === 'task-output' ? 30_000 : 0,
          },
    )
  } else if (
    mode === 'status-stop' &&
    workflowUses.length === 1 &&
    taskOutputUses.length === 1 &&
    taskOutputUses[0]?.name === 'TaskOutput' &&
    taskId
  ) {
    responseEvents = toolEvents('workflow_stop_call', 'TaskStop', {
      task_id: taskId,
    })
  } else if (
    isWorkflowRun &&
    workflowUses.length === 0 &&
    captured.tools?.some(({ name }) => name === 'Workflow')
  ) {
    responseEvents = toolEvents(
      'workflow_probe_call',
      'Workflow',
      mode === 'named'
        ? { name: 'saved-probe', args: { probe: 23 } }
        : mode === 'error'
          ? workflowInput
          : { script, args: { probe: 23 } },
    )
  } else if (
    mode === 'resume' &&
    workflowUses.length === 1 &&
    notifications?.length &&
    scriptPath &&
    runId
  ) {
    responseEvents = toolEvents('workflow_resume_call', 'Workflow', {
      scriptPath,
      resumeFromRunId: runId,
      args: { probe: 23 },
    })
  } else {
    responseEvents = events(
      [
        'agent',
        'resume',
        'structured',
        'task-output',
        'stop',
        'status-stop',
        'failure',
      ].includes(mode)
        ? 'WORKFLOW_AGENT_RESPONSE'
        : mode === 'lifecycle'
          ? 'WORKFLOW_LIFECYCLE_DONE'
          : 'WORKFLOW_SCHEMA_CAPTURED',
    )
  }
  turn += 1
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    responseEvents
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

async function snapshot(directory, base = directory) {
  const entries = []
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const metadata = await stat(path)
    if (metadata.isDirectory()) {
      entries.push(...(await snapshot(path, base)))
      continue
    }
    const relative = path.slice(base.length + 1)
    const source =
      metadata.size <= 128 * 1024 ? await readFile(path, 'utf8') : '<large>'
    entries.push({ path: relative, size: metadata.size, source })
  }
  return entries
}

function closeProvider() {
  return new Promise((resolve, reject) =>
    provider.close((error) => (error ? reject(error) : resolve())),
  )
}

try {
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(cwd, { recursive: true }),
    listen(),
  ])
  if (mode === 'named') {
    const workflowDirectory = join(cwd, '.claude', 'workflows')
    await mkdir(workflowDirectory, { recursive: true })
    await writeFile(
      join(workflowDirectory, 'saved-probe.js'),
      `export const meta = {
  name: 'saved-probe',
  description: 'Probe saved workflow resolution',
  whenToUse: 'When Stage 23 tests named workflows',
  phases: [{ title: 'Saved', detail: 'return saved marker' }],
}
phase('Saved')
return { marker: 'SAVED_WORKFLOW_RESULT', args }`,
    )
  }
  const address = provider.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  const result = await execFileAsync(
    'claude',
    [
      '-p',
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      isWorkflowRun ? '6' : mode === 'wakeup' ? '3' : '1',
      ...(isWorkflowRun && mode !== 'permission'
        ? ['--dangerously-skip-permissions']
        : []),
      '--output-format',
      'json',
      prompt ??
        (isWorkflowRun
          ? 'run the requested minimal workflow'
          : mode === 'wakeup'
            ? '/loop check build'
            : 'return workflow schema marker'),
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
  if (isWorkflowRun) {
    const files = await snapshot(root)
    console.log(
      JSON.stringify(
        process.env.PRAXIS_WORKFLOW_PROBE_SUMMARY === '1'
          ? {
              root,
              configRoot,
              cwd,
              sessionId: JSON.parse(result.stdout).session_id,
              requests: requests.map(({ model, thinking, output_config }) => ({
                model,
                thinking,
                output_config,
              })),
              files: files.filter(({ path }) =>
                /(?:journal\.jsonl|\.meta\.json|workflows\/wf_.*\.json)$/u.test(
                  path,
                ),
              ),
            }
          : {
              stdout: JSON.parse(result.stdout),
              requests,
              files,
            },
        null,
        2,
      ),
    )
  } else {
    const selected = captured?.tools?.filter(({ name }) =>
      ['Workflow', 'ScheduleWakeup'].includes(name),
    )
    console.log(
      JSON.stringify(
        {
          stdout: JSON.parse(result.stdout),
          tools: selected,
          system: captured?.system,
          messages: captured?.messages,
        },
        null,
        2,
      ),
    )
  }
} finally {
  await closeProvider().catch(() => undefined)
  if (!keepRoot) await rm(root, { recursive: true, force: true })
}
