import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-metering-'))
const requests = []
const server = createServer(async (request, response) => {
  let source = ''
  request.setEncoding('utf8')
  for await (const chunk of request) source += chunk
  requests.push(JSON.parse(source))
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_metering',
        type: 'message',
        role: 'assistant',
        model: 'fixture-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100 },
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
      delta: { type: 'text_delta', text: 'metered' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 20 },
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
    PRAXIS_PRICING_JSON:
      '{"fixture-model":{"inputPerMillionUsd":1,"outputPerMillionUsd":2}}',
  }
  const result = await execFileAsync(
    process.execPath,
    [
      'dist/cli.js',
      '-p',
      '--model',
      'fixture-model',
      '--output-format',
      'json',
      '--max-budget-usd',
      '1',
      'meter this',
    ],
    { cwd: new URL('..', import.meta.url), env, timeout: 30_000 },
  )
  const output = JSON.parse(result.stdout)
  if (output.is_error || output.total_cost_usd !== 0.00014) {
    throw new Error(`Unexpected metering result: ${JSON.stringify(output)}`)
  }
  if (
    typeof output.duration_api_ms !== 'number' ||
    output.duration_api_ms < 0
  ) {
    throw new Error('API duration was not measured')
  }
  if (requests[0]?.model !== 'fixture-model') {
    throw new Error('Model was not forwarded')
  }
  console.log('Metering and budget compatibility checks passed.')
} finally {
  await new Promise((resolve) => server.close(resolve)).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}
