import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-prompt-suggestions-'))
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
    throw new Error('no server address')
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: join(root, 'config'),
    PRAXIS_PROVIDER: 'anthropic',
    PRAXIS_API_KEY: 'fixture-key',
    PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}`,
  }
  const result = await execFileAsync(
    process.execPath,
    [
      'dist/cli.js',
      '-p',
      '--model',
      'fixture-model',
      '--output-format',
      'stream-json',
      '--verbose',
      '--prompt-suggestions',
      'suggest next',
    ],
    { cwd: new URL('..', import.meta.url), env, timeout: 30_000 },
  )
  const records = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  if (
    !JSON.stringify(requests[1]?.messages?.at(-1)).includes('[SUGGESTION MODE:')
  ) {
    throw new Error(
      'Suggestion instruction was not sent as a temporary user message',
    )
  }
  if (
    records.at(-2)?.type !== 'result' ||
    records.at(-1)?.type !== 'prompt_suggestion'
  ) {
    throw new Error(
      `Unexpected suggestion event order: ${JSON.stringify(records)}`,
    )
  }
  if (records.at(-1)?.suggestion !== 'continue the implementation') {
    throw new Error('Suggestion text did not survive stream-json output')
  }
  if (requests.length !== 2)
    throw new Error(`Expected two provider requests, got ${requests.length}`)
  console.log('Prompt suggestion compatibility checks passed.')
} finally {
  await new Promise((resolve) => server.close(resolve)).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}
