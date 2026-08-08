import { execFile } from 'node:child_process'
import {
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
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import { detectClaudeVersion } from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-thinking-compat-'))
const configRoot = join(root, 'config')
const workDirectory = join(root, 'project')
let cwd = workDirectory
const requests = []

function responseEvents(body) {
  const source = JSON.stringify(body.messages ?? [])
  const toolResult = source.includes('tool_result')
  const toolTurn = source.includes('THINKING_TOOL_TURN_MARKER') && !toolResult
  const thinking = body.thinking?.type !== 'disabled'
  const blocks = []
  if (thinking) {
    blocks.push({
      start: { type: 'thinking', thinking: '' },
      deltas: [
        { type: 'thinking_delta', thinking: 'private fixture thought' },
        { type: 'signature_delta', signature: 'fixture-signature' },
      ],
    })
  }
  if (toolTurn) {
    blocks.push({
      start: {
        type: 'tool_use',
        id: 'call_read_thinking',
        name: 'Read',
        input: {},
      },
      deltas: [
        {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ file_path: join(cwd, 'README.md') }),
        },
      ],
    })
  } else {
    blocks.push({
      start: { type: 'text', text: '' },
      deltas: [
        {
          type: 'text_delta',
          text: toolResult ? 'TOOL_TURN_COMPLETE' : 'PUBLIC_ANSWER',
        },
      ],
    })
  }
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_thinking_${requests.length}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    },
    ...blocks.flatMap((block, index) => [
      { type: 'content_block_start', index, content_block: block.start },
      ...block.deltas.map((delta) => ({
        type: 'content_block_delta',
        index,
        delta,
      })),
      { type: 'content_block_stop', index },
    ]),
    {
      type: 'message_delta',
      delta: {
        stop_reason: toolTurn ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: { output_tokens: 4 },
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
  const body = JSON.parse(source)
  requests.push(body)
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    responseEvents(body)
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
  )
})

function assert(value, message) {
  if (!value) throw new Error(message)
}

function hasThinking(value, signature = 'fixture-signature') {
  return JSON.stringify(value).includes(`"signature":"${signature}"`)
}

function parseJsonResult(stdout, label) {
  const result = JSON.parse(stdout)
  assert(result.is_error !== true, `${label} failed: ${stdout}`)
  return result
}

function transcriptEntries(sessionId) {
  const path = resolveClaudePaths({
    configDir: configRoot,
    cwd,
    sessionId,
  }).sessionFile
  return readFile(path, 'utf8').then((source) =>
    source
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  )
}

async function waitForPersistedThinking(sessionId) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      if (hasThinking(await transcriptEntries(sessionId))) return true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await delay(50)
  }
  return false
}

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})

try {
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(workDirectory, { recursive: true }),
  ])
  cwd = await realpath(workDirectory)
  await writeFile(join(cwd, 'README.md'), '# thinking fixture\n')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const praxisEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configRoot,
    PRAXIS_PROVIDER: 'anthropic',
    PRAXIS_API_KEY: 'fixture-key',
    PRAXIS_MODEL: 'claude-sonnet-4-5-20250929',
    PRAXIS_BASE_URL: `${baseUrl}/v1`,
    PRAXIS_MAX_OUTPUT_TOKENS: '4096',
  }
  const claudeEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configRoot,
    ANTHROPIC_API_KEY: 'fixture-key',
    ANTHROPIC_BASE_URL: baseUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  const cli = join(process.cwd(), 'dist', 'cli.js')
  const runPraxis = (args, env = praxisEnv) =>
    execFileAsync(process.execPath, [cli, ...args], {
      cwd,
      env,
      timeout: 30_000,
    })
  const runClaude = (args) =>
    execFileAsync('claude', args, { cwd, env: claudeEnv, timeout: 30_000 })

  const beforePraxisDefault = requests.length
  const praxisDefault = await runPraxis([
    '-p',
    '--no-session-persistence',
    '--tools=',
    '--output-format',
    'json',
    'DEFAULT_THINKING',
  ])
  assert(
    parseJsonResult(praxisDefault.stdout, 'Praxis default').result ===
      'PUBLIC_ANSWER',
    'Praxis default exposed or lost answer text',
  )
  assert(
    requests[beforePraxisDefault]?.thinking?.type === 'enabled' &&
      requests[beforePraxisDefault]?.thinking?.budget_tokens === 4095,
    'Praxis Anthropic default thinking contract was not applied',
  )

  const claudeSession = '63000000-0000-4000-8000-000000000001'
  const beforeClaude = requests.length
  const claudeSeed = await runClaude([
    '--bare',
    '-p',
    '--thinking',
    'enabled',
    '--session-id',
    claudeSession,
    '--model',
    'claude-sonnet-4-5-20250929',
    '--max-turns',
    '1',
    '--tools=',
    '--output-format',
    'json',
    'CLAUDE_THINKING_SEED',
  ])
  assert(
    parseJsonResult(claudeSeed.stdout, 'Claude seed').result ===
      'PUBLIC_ANSWER',
    'Claude exposed or lost answer text',
  )
  assert(
    requests[beforeClaude]?.thinking?.type === 'enabled',
    'Claude enabled-thinking request was not observed',
  )
  assert(
    await waitForPersistedThinking(claudeSession),
    'Claude did not persist signed thinking',
  )

  const beforePraxisResume = requests.length
  const praxisResume = await runPraxis([
    '-p',
    '--resume',
    claudeSession,
    '--thinking',
    'enabled',
    '--tools=',
    '--output-format',
    'json',
    'PRAXIS_RESUME_CLAUDE_THINKING',
  ])
  assert(
    parseJsonResult(praxisResume.stdout, 'Praxis Claude resume').result ===
      'PUBLIC_ANSWER',
    'Praxis exposed or lost answer text',
  )
  assert(
    hasThinking(requests[beforePraxisResume]?.messages),
    'Praxis did not replay Claude signed thinking',
  )

  const praxisSession = '63000000-0000-4000-8000-000000000002'
  const beforeToolTurn = requests.length
  const praxisTool = await runPraxis([
    '-p',
    '--session-id',
    praxisSession,
    '--thinking',
    'adaptive',
    '--max-thinking-tokens',
    '2048',
    '--tools',
    'Read',
    '--output-format',
    'json',
    'THINKING_TOOL_TURN_MARKER',
  ])
  assert(
    parseJsonResult(praxisTool.stdout, 'Praxis tool turn').result ===
      'TOOL_TURN_COMPLETE',
    'Praxis thinking tool turn failed',
  )
  const firstToolRequest = requests[beforeToolTurn]
  const secondToolRequest = requests[beforeToolTurn + 1]
  assert(
    firstToolRequest?.thinking?.type === 'enabled',
    'Praxis adaptive mode did not map to target enabled-thinking request',
  )
  assert(
    firstToolRequest?.thinking?.budget_tokens === 2048,
    'Praxis thinking budget was not applied',
  )
  assert(
    hasThinking(secondToolRequest?.messages),
    'Praxis dropped signed thinking before tool continuation',
  )
  assert(
    await waitForPersistedThinking(praxisSession),
    'Praxis did not persist signed thinking',
  )

  const beforeClaudeResume = requests.length
  const claudeResume = await runClaude([
    '--bare',
    '-p',
    '--resume',
    praxisSession,
    '--thinking',
    'enabled',
    '--model',
    'claude-sonnet-4-5-20250929',
    '--max-turns',
    '1',
    '--tools=',
    '--output-format',
    'json',
    'CLAUDE_RESUME_PRAXIS_THINKING',
  ])
  parseJsonResult(claudeResume.stdout, 'Claude Praxis resume')
  assert(
    hasThinking(requests[beforeClaudeResume]?.messages),
    'Claude did not replay Praxis signed thinking',
  )

  const beforeDisabled = requests.length
  await runPraxis([
    '-p',
    '--no-session-persistence',
    '--thinking',
    'disabled',
    '--tools=',
    '--output-format',
    'json',
    'DISABLED_THINKING',
  ])
  assert(
    requests[beforeDisabled]?.thinking?.type === 'disabled',
    'Praxis disabled-thinking request was not applied',
  )

  const stream = await runPraxis([
    '-p',
    '--no-session-persistence',
    '--thinking',
    'enabled',
    '--tools=',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    'STREAM_THINKING',
  ])
  const streamRecords = stream.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert(
    streamRecords.some(
      (record) =>
        record.type === 'stream_event' &&
        record.event?.delta?.type === 'thinking_delta',
    ),
    'Praxis partial stream omitted thinking delta',
  )
  assert(
    streamRecords.find((record) => record.type === 'result')?.result ===
      'PUBLIC_ANSWER',
    'Praxis result leaked thinking text',
  )

  const invalidBefore = requests.length
  await runPraxis([
    '-p',
    '--thinking',
    'disabled',
    '--max-thinking-tokens',
    '10',
    'invalid',
  ]).then(
    () => {
      throw new Error('Conflicting thinking controls unexpectedly succeeded')
    },
    (error) =>
      assert(
        String(error.stderr).includes('cannot be combined'),
        'Conflicting thinking controls returned wrong error',
      ),
  )
  assert(requests.length === invalidBefore, 'Invalid controls reached provider')

  await runPraxis(['-p', '--thinking', 'enabled', 'unsupported'], {
    ...praxisEnv,
    PRAXIS_PROVIDER: 'openai',
    PRAXIS_BASE_URL: `${baseUrl}/v1`,
    PRAXIS_MAX_OUTPUT_TOKENS: undefined,
  }).then(
    () => {
      throw new Error('Unsupported OpenAI thinking unexpectedly succeeded')
    },
    (error) =>
      assert(
        String(error.stderr).includes('does not support'),
        `Unsupported provider returned wrong error: ${String(error.stderr || error.message)}`,
      ),
  )

  const version = await detectClaudeVersion('thinking controls gate')
  console.log(
    `Claude ${version}/Praxis thinking controls passed: modes, budget, hidden output, partial stream, signed tool continuation, native JSONL, and bidirectional resume`,
  )
} finally {
  await new Promise((resolve) => server.close(resolve)).catch(() => undefined)
  await rm(root, { recursive: true })
}
