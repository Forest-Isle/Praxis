import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { detectClaudeVersion } from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-glob-compat-'))
const configRoot = join(root, 'config')
const requests = []
const responses = []
let messageNumber = 0

function messageStart() {
  messageNumber += 1
  return {
    type: 'message_start',
    message: {
      id: `msg_glob_${messageNumber}`,
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

function toolEvents(id, input) {
  return [
    messageStart(),
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id, name: 'Glob', input: {} },
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
  const events = responses.shift()
  if (!events) throw new Error('Glob provider response queue exhausted')
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

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function toolResult(request, id) {
  return request.messages
    ?.flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .find((block) => block.type === 'tool_result' && block.tool_use_id === id)
}

function toolResultText(request, id) {
  const result = toolResult(request, id)
  if (typeof result?.content === 'string') return result.content
  if (!Array.isArray(result?.content)) return undefined
  return result.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function assertGlobDefinition(request, label) {
  const definition = request.tools?.find((tool) => tool.name === 'Glob')
  assert(definition, `${label} did not expose Glob`)
  assert(
    definition.input_schema?.type === 'object' &&
      definition.input_schema?.properties?.pattern?.type === 'string' &&
      definition.input_schema?.properties?.path?.type === 'string' &&
      definition.input_schema?.required?.length === 1 &&
      definition.input_schema.required[0] === 'pattern' &&
      definition.input_schema.additionalProperties === false,
    `${label} Glob schema changed`,
  )
}

async function createFixture(cwd, additional) {
  await Promise.all([
    mkdir(join(cwd, 'src', '.hidden'), { recursive: true }),
    mkdir(join(cwd, 'many'), { recursive: true }),
    mkdir(additional, { recursive: true }),
  ])
  const files = [
    join(cwd, 'src', 'old.ts'),
    join(cwd, 'src', '.hidden', 'secret.ts'),
    join(cwd, 'src', 'new.ts'),
    join(cwd, 'ignored.ts'),
  ]
  await Promise.all([
    ...files.map((path) => writeFile(path, '')),
    writeFile(join(cwd, '.gitignore'), 'ignored.ts\n'),
    writeFile(join(additional, 'extra.ts'), ''),
  ])
  await Promise.all(
    files.map((path, index) => utimes(path, 1_000 + index, 1_000 + index)),
  )
  await Promise.all(
    Array.from({ length: 102 }, async (_, index) => {
      const path = join(cwd, 'many', `${String(index).padStart(3, '0')}.txt`)
      await writeFile(path, '')
      await utimes(path, 2_000 + index, 2_000 + index)
    }),
  )
}

function callsFor(prefix, additional) {
  const many = [
    ...Array.from(
      { length: 100 },
      (_, index) => `many/${String(index).padStart(3, '0')}.txt`,
    ),
    '(Showing 100 of 102 matching files; 2 more are not listed. Narrow the pattern or path to see the rest.)',
  ].join('\n')
  return [
    {
      id: `${prefix}-default`,
      input: { pattern: '*.ts' },
      expected: 'src/old.ts\nsrc/.hidden/secret.ts\nsrc/new.ts\nignored.ts',
    },
    {
      id: `${prefix}-none`,
      input: { pattern: '**/*.missing' },
      expected: 'No files found',
    },
    {
      id: `${prefix}-brace`,
      input: { pattern: 'src/{old,new}.ts' },
      expected: 'src/old.ts\nsrc/new.ts',
    },
    {
      id: `${prefix}-extglob`,
      input: { pattern: 'src/@(old|new).ts' },
      expected: 'No files found',
    },
    {
      id: `${prefix}-many`,
      input: { pattern: 'many/*.txt' },
      expected: many,
    },
    {
      id: `${prefix}-additional`,
      input: { pattern: '*.ts', path: additional },
      expected: join(additional, 'extra.ts'),
    },
  ]
}

function queueCalls(calls, finalText) {
  for (const call of calls) responses.push(toolEvents(call.id, call.input))
  responses.push(textEvents(finalText))
}

function assertCallResults(runRequests, calls, label) {
  assertGlobDefinition(runRequests[0], label)
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]
    const actual = toolResultText(runRequests[index + 1], call.id)
    assert(
      actual === call.expected,
      `${label} ${call.id} result changed: expected=${JSON.stringify(call.expected)} actual=${JSON.stringify(actual)}`,
    )
  }
}

try {
  const claudeCwd = join(root, 'claude-work')
  const claudeAdditional = join(root, 'claude-additional')
  const praxisCwd = join(root, 'praxis-work')
  const praxisAdditional = join(root, 'praxis-additional')
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    createFixture(claudeCwd, claudeAdditional),
    createFixture(praxisCwd, praxisAdditional),
  ])
  await listen()
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Glob fixture server has no TCP address')
  }
  const baseUrl = `http://127.0.0.1:${address.port}`

  const claudeCalls = callsFor('claude', claudeAdditional)
  queueCalls(claudeCalls, 'CLAUDE_GLOB_DONE')
  const claudeStart = requests.length
  await execFileAsync(
    'claude',
    [
      '-p',
      '--safe-mode',
      '--dangerously-skip-permissions',
      '--add-dir',
      claudeAdditional,
      '--tools',
      'Glob',
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      String(claudeCalls.length + 1),
      '--output-format',
      'json',
      'glob files',
    ],
    {
      cwd: claudeCwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: baseUrl,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    },
  )
  assertCallResults(requests.slice(claudeStart), claudeCalls, 'Claude')

  const sessionId = '66666666-6666-4666-8666-666666666666'
  const praxisCalls = callsFor('praxis', praxisAdditional)
  queueCalls(praxisCalls, 'PRAXIS_GLOB_DONE')
  const praxisStart = requests.length
  const praxisExecution = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), 'dist', 'cli.js'),
      '-p',
      '--session-id',
      sessionId,
      '--add-dir',
      praxisAdditional,
      '--tools',
      'Glob',
      '--output-format',
      'json',
      '--',
      'glob files',
    ],
    {
      cwd: praxisCwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_API_KEY: 'fixture-key',
        PRAXIS_MODEL: 'fixture-model',
        PRAXIS_BASE_URL: `${baseUrl}/v1`,
      },
    },
  )
  const praxisResult = JSON.parse(praxisExecution.stdout)
  assert(
    praxisResult.session_id === sessionId && praxisResult.is_error === false,
    `Praxis Glob run failed: ${praxisExecution.stdout}`,
  )
  assertCallResults(requests.slice(praxisStart), praxisCalls, 'Praxis')

  responses.push(textEvents('CLAUDE_RESUMED_PRAXIS_GLOB'))
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
      '--tools=',
      '--output-format',
      'json',
      'resume glob session',
    ],
    {
      cwd: praxisCwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: baseUrl,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    },
  )
  const resumedResult = JSON.parse(resumed.stdout)
  assert(
    resumedResult.session_id === sessionId && resumedResult.is_error === false,
    `Claude could not resume Praxis Glob session: ${resumed.stdout}`,
  )

  const version = await detectClaudeVersion('Glob compatibility probe')
  console.log(
    `Claude ${version} Glob compatibility passed: schema, brace/no-extglob syntax, relative/additional paths, no-match and 100-result bounds, Praxis tool round trip, and Claude resume`,
  )
} finally {
  if (server.listening) await closeServer()
  await rm(root, { recursive: true, force: true })
}
