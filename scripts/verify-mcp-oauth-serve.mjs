import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-oauth-serve-'))
const configRoot = join(root, 'config')
const lspPlugin = join(root, 'lsp-plugin')
const cliPath = join(process.cwd(), 'dist', 'cli.js')
let env
let providerRequest = 0

const provider = createServer(async (request, response) => {
  if (request.method === 'HEAD') {
    response.writeHead(200).end()
    return
  }
  let source = ''
  request.setEncoding('utf8')
  for await (const chunk of request) source += chunk
  if (!source || request.url !== '/v1/messages') {
    response.writeHead(404).end()
    return
  }
  providerRequest += 1
  const text = `MCP_AGENT_RESPONSE_${providerRequest}`
  const events = [
    {
      type: 'message_start',
      message: {
        id: `msg_mcp_agent_${providerRequest}`,
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

function listenProvider() {
  return new Promise((resolve, reject) => {
    provider.once('error', reject)
    provider.listen(0, '127.0.0.1', resolve)
  })
}

function closeProvider() {
  return new Promise((resolve, reject) => {
    provider.close((error) => (error ? reject(error) : resolve()))
  })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  )
}

async function listWith(command, args) {
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: root,
    env,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'praxis-mcp-verifier', version: '1' })
  try {
    await client.connect(transport)
    return {
      version: client.getServerVersion(),
      tools: (await client.listTools()).tools,
    }
  } finally {
    await client.close().catch(() => undefined)
  }
}

try {
  await listenProvider()
  const providerAddress = provider.address()
  if (!providerAddress || typeof providerAddress === 'string') {
    throw new Error('MCP Agent fixture provider has no TCP address')
  }
  env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configRoot,
    PRAXIS_DATA_PLANE: 'native',
    PRAXIS_HOME: configRoot,
    PRAXIS_MCP_OAUTH_STORE: 'file',
    PRAXIS_PROVIDER: 'anthropic',
    PRAXIS_API_KEY: 'fixture-key',
    PRAXIS_MODEL: 'fixture-model',
    PRAXIS_BASE_URL: `http://127.0.0.1:${providerAddress.port}/v1`,
  }
  await writeFile(join(root, 'fixture.txt'), 'mcp serve fixture\n')
  await mkdir(join(lspPlugin, '.claude-plugin'), { recursive: true })
  await writeFile(
    join(lspPlugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'mcp-lsp-fixture', version: '1.0.0' }),
  )
  await writeFile(
    join(lspPlugin, '.lsp.json'),
    JSON.stringify({
      fixture: {
        command: 'must-not-run-in-mcp-serve',
        extensionToLanguage: { '.fixture': 'fixture' },
      },
    }),
  )
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, '--plugin-dir', lspPlugin, 'mcp', 'serve', '--debug'],
    cwd: root,
    env,
    stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const client = new Client({ name: 'praxis-mcp-verifier', version: '1' })
  await client.connect(transport)
  const listed = await client.listTools()
  const names = listed.tools.map((tool) => tool.name)
  assert(
    !names.includes('LSP'),
    'Praxis mcp serve exposed interactive-only plugin LSP',
  )
  const expectedPrefix = [
    'Agent',
    'TaskOutput',
    'Bash',
    'Read',
    'Edit',
    'Write',
    'NotebookEdit',
  ]
  assert(
    expectedPrefix.every((name, index) => names[index] === name),
    `Unexpected Praxis mcp serve tool order: ${JSON.stringify(names)}`,
  )
  assert(
    listed.tools.some((tool) => tool.name === 'Agent'),
    'Praxis mcp serve did not expose Agent',
  )
  assert(
    listed.tools.some((tool) => tool.name === 'TaskOutput'),
    'Praxis mcp serve did not expose TaskOutput',
  )
  const schema = new Map(
    listed.tools.map((tool) => [tool.name, tool.inputSchema]),
  )
  const assertSchema = (name, expected) => {
    const actual = schema.get(name)
    assert(actual, `Praxis mcp serve missing schema for ${name}`)
    for (const [key, value] of Object.entries(expected)) {
      assert(
        JSON.stringify(actual[key]) === JSON.stringify(value),
        `Unexpected ${name}.${key} schema: ${JSON.stringify(actual[key])}`,
      )
    }
  }
  assertSchema('Agent', {
    required: ['description', 'prompt'],
    additionalProperties: false,
  })
  assertSchema('TaskOutput', {
    required: ['task_id', 'block', 'timeout'],
    additionalProperties: false,
  })
  assertSchema('TaskCreate', {
    required: ['subject', 'description'],
    additionalProperties: false,
  })
  assertSchema('Workflow', { additionalProperties: false })
  for (const name of [
    'WebFetch',
    'ReportFindings',
    'WebSearch',
    'Skill',
    'TaskCreate',
    'TaskGet',
    'TaskList',
    'TaskUpdate',
    'TaskStop',
    'SendMessage',
    'CronCreate',
    'CronDelete',
    'CronList',
    'ScheduleWakeup',
    'Workflow',
  ]) {
    assert(names.includes(name), `Praxis mcp serve missing ${name}`)
  }
  const result = await client.callTool({
    name: 'Read',
    arguments: { file_path: 'fixture.txt' },
  })
  const text = result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
  assert(text.includes('mcp serve fixture'), 'Read call failed over stdio')
  const createdTask = await client.callTool({
    name: 'TaskCreate',
    arguments: { subject: 'MCP task', description: 'MCP task fixture' },
  })
  const createdText = createdTask.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
  assert(
    createdText.includes('Task #1 created successfully'),
    'TaskCreate call failed',
  )
  const listedTasks = await client.callTool({
    name: 'TaskList',
    arguments: {},
  })
  const taskText = listedTasks.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
  assert(taskText.includes('#1 [pending] MCP task'), 'TaskList call failed')
  const findings = await client.callTool({
    name: 'ReportFindings',
    arguments: {
      level: 'high',
      findings: [
        {
          file: 'fixture.txt',
          line: 1,
          summary: 'Fixture finding',
          failure_scenario: 'Fixture input produces wrong output',
        },
      ],
    },
  })
  assert(
    findings.content.some(
      (item) =>
        item.type === 'text' &&
        item.text.includes('"count":1') &&
        item.text.includes('"level":"high"'),
    ),
    'ReportFindings call failed',
  )
  const createdCron = await client.callTool({
    name: 'CronCreate',
    arguments: { cron: '17 * * * *', prompt: 'MCP cron fixture' },
  })
  const cronText = createdCron.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
  const cronId = cronText.match(/Scheduled recurring job ([a-z0-9]+)/u)?.[1]
  assert(cronId, 'CronCreate call failed')
  const deletedCron = await client.callTool({
    name: 'CronDelete',
    arguments: { id: cronId },
  })
  assert(
    deletedCron.content.some(
      (item) =>
        item.type === 'text' && item.text.includes(`Cancelled job ${cronId}`),
    ),
    'CronDelete call failed',
  )
  const agent = await client.callTool({
    name: 'Agent',
    arguments: {
      description: 'MCP Agent fixture',
      prompt: 'Return MCP_AGENT_RESPONSE',
      run_in_background: false,
    },
  })
  const agentText = agent.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
  assert(
    agentText.includes('MCP_AGENT_RESPONSE_1') && providerRequest === 1,
    `Agent call did not use configured provider: ${agentText}`,
  )
  const workflowScript = `export const meta = {
  name: 'mcp-serve-fixture',
  description: 'Verify hosted Workflow lifecycle',
}
return { marker: 'MCP_WORKFLOW_COMPLETE' }`
  const workflow = await client.callTool({
    name: 'Workflow',
    arguments: { script: workflowScript },
  })
  const workflowLaunch = workflow.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
  const workflowId = workflowLaunch.match(/Task ID: (w[a-z0-9]{8})/u)?.[1]
  assert(workflowId, `Workflow launch failed: ${workflowLaunch}`)
  const workflowOutput = await client.callTool({
    name: 'TaskOutput',
    arguments: { task_id: workflowId, block: true, timeout: 5000 },
  })
  assert(
    workflowOutput.content.some(
      (item) =>
        item.type === 'text' && item.text.includes('MCP_WORKFLOW_COMPLETE'),
    ),
    'Workflow TaskOutput failed',
  )
  await client.close()
  assert(
    stderr.includes('MCP tool call: Read'),
    `mcp serve debug output missing: ${stderr}`,
  )

  const claude = await execFileAsync('claude', ['--version'], {
    cwd: root,
    env,
  }).catch(() => null)
  if (claude) {
    const claudeResult = await listWith('claude', ['mcp', 'serve'])
    const claudeNames = new Set(claudeResult.tools.map((tool) => tool.name))
    for (const name of [
      'Agent',
      'TaskOutput',
      'Bash',
      'Read',
      'Edit',
      'Write',
      'NotebookEdit',
    ]) {
      assert(
        claudeNames.has(name),
        `Claude fixture missing expected tool ${name}`,
      )
    }
    for (const name of [
      'Agent',
      'TaskOutput',
      'Bash',
      'Read',
      'Edit',
      'Write',
    ]) {
      assert(names.includes(name), `Praxis missing Claude tool ${name}`)
    }
    const claudeSchemas = new Map(
      claudeResult.tools.map((tool) => [tool.name, tool.inputSchema]),
    )
    for (const name of ['Agent', 'TaskOutput', 'ReportFindings']) {
      assert(
        JSON.stringify(canonical(schema.get(name))) ===
          JSON.stringify(canonical(claudeSchemas.get(name))),
        `Praxis schema diverges from Claude for ${name}: ${JSON.stringify({ praxis: canonical(schema.get(name)), claude: canonical(claudeSchemas.get(name)) })}`,
      )
    }
  }
  console.log('MCP OAuth/serve compatibility checks passed.')
} finally {
  await closeProvider().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}
