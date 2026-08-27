import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join } from 'node:path'

const execFile = promisify(execFileCallback)
const root = new URL('..', import.meta.url)
const configDir = await mkdtemp(join(tmpdir(), 'praxis-prompt-suggestions-'))
const requests = []
let requestCount = 0

const server = createServer(async (request, response) => {
  let source = ''
  request.setEncoding('utf8')
  for await (const chunk of request) source += chunk
  requests.push(JSON.parse(source))
  requestCount += 1
  const text =
    requestCount === 1 ? 'main answer' : 'continue the implementation'
  const events = [
    {
      type: 'message_start',
      message: {
        id: `msg_${requestCount}`,
        type: 'message',
        role: 'assistant',
        model: 'fixture-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10 },
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
      usage: { output_tokens: 3 },
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

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})

try {
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('fixture server did not expose an address')
  const env = {
    ...process.env,
    PRAXIS_PROVIDER: 'anthropic',
    PRAXIS_API_KEY: 'fixture-key',
    PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}`,
    PRAXIS_HOME: configDir,
  }
  for (const key of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ])
    delete env[key]

  const { stdout: help } = await execFile(
    process.execPath,
    ['dist/cli.js', '--help'],
    { cwd: root, env },
  )
  const normalizedHelp = help.replace(/\s+/g, ' ')
  if (!help.includes('--prompt-suggestions [value]'))
    throw new Error('Root help omitted optional prompt-suggestions value')
  if (!normalizedHelp.includes('choices: "true", "false", "1", "0"'))
    throw new Error('Root help omitted prompt-suggestions choices')

  const invalidMessage =
    "option '--prompt-suggestions [value]' argument 'maybe' is invalid. Allowed choices are true, false, 1, 0, yes, no, on, off."
  try {
    await execFile(
      process.execPath,
      [
        'dist/cli.js',
        '-p',
        '--output-format=stream-json',
        '--verbose',
        '--prompt-suggestions',
        'maybe',
      ],
      { cwd: root, env },
    )
    throw new Error('CLI accepted invalid prompt suggestions')
  } catch (error) {
    if (!String(error.stderr).includes(invalidMessage)) throw error
  }

  try {
    await execFile(
      process.execPath,
      ['dist/cli.js', '--prompt-suggestions=true', 'mcp', 'get', 'missing'],
      { cwd: root, env },
    )
    throw new Error('CLI unexpectedly found missing MCP server')
  } catch (error) {
    const stderr = String(error.stderr)
    if (
      !stderr.includes('missing') ||
      stderr.includes('--prompt-suggestions requires')
    )
      throw error
  }

  const result = await execFile(
    process.execPath,
    [
      'dist/cli.js',
      '-p',
      '--model',
      'fixture-model',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '1',
      '--prompt-suggestions',
      'true',
      '--',
      'suggest next',
    ],
    { cwd: root, env, timeout: 30_000 },
  )
  const records = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  if (
    !requests.some((request) =>
      JSON.stringify(request.messages?.at(-1)).includes('[SUGGESTION MODE:'),
    )
  )
    throw new Error(
      'Suggestion instruction was not sent as a temporary user message',
    )
  if (
    records.at(-2)?.type !== 'result' ||
    records.at(-1)?.type !== 'prompt_suggestion'
  )
    throw new Error(
      `Unexpected suggestion event order: ${JSON.stringify(records)}`,
    )
  if (records.at(-1)?.suggestion !== 'continue the implementation')
    throw new Error('Suggestion text did not survive stream-json output')

  const disabled = await execFile(
    process.execPath,
    [
      'dist/cli.js',
      '-p',
      '--model',
      'fixture-model',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '1',
      '--prompt-suggestions',
      'false',
      '--',
      'no suggestion',
    ],
    { cwd: root, env, timeout: 30_000 },
  )
  if (disabled.stdout.includes('"type":"prompt_suggestion"'))
    throw new Error('False prompt-suggestions emitted a prompt suggestion')
  const countedRequests = requests.filter((request) => {
    const lastMessage = JSON.stringify(request.messages?.at(-1))
    return !lastMessage.includes('Conversation so far:')
  })
  if (countedRequests.length !== 3)
    throw new Error(
      `Expected three prompt provider requests, got ${countedRequests.length}`,
    )
  console.log('Native prompt suggestion checks passed.')
} finally {
  await new Promise((resolve) => server.close(resolve)).catch(() => undefined)
  await rm(configDir, { recursive: true, force: true })
}
