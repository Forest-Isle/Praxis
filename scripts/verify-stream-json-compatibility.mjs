import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-stream-json-'))
const server = createServer(async (_request, response) => {
  let source = ''
  _request.setEncoding('utf8')
  for await (const chunk of _request) source += chunk
  if (!source) throw new Error('provider received an empty request')
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_stream_gate',
        type: 'message',
        role: 'assistant',
        model: 'fixture-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 2 },
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
      delta: { type: 'text_delta', text: 'stream gate' },
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

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})

try {
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('no server address')
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
      'stream gate',
    ],
    {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: join(root, 'config'),
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_API_KEY: 'fixture-key',
        PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}`,
      },
      timeout: 30_000,
    },
  )
  const records = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const subtypes = records
    .filter((record) => record.type === 'system')
    .map((record) => record.subtype)
  for (const subtype of ['init', 'session_state_changed']) {
    if (!subtypes.includes(subtype))
      throw new Error(`Missing stream-json system subtype: ${subtype}`)
  }
  const init = records.find(
    (record) => record.type === 'system' && record.subtype === 'init',
  )
  if (
    typeof init?.uuid !== 'string' ||
    init.output_style !== 'default' ||
    !Array.isArray(init.plugins)
  ) {
    throw new Error(`Invalid init envelope: ${JSON.stringify(init)}`)
  }
  if (records.at(-1)?.type !== 'result')
    throw new Error(`Missing terminal result: ${JSON.stringify(records)}`)
  if (!records.some((record) => record.type === 'assistant'))
    throw new Error('Missing assistant stream record')
  if (
    typeof records.at(-1)?.uuid !== 'string' ||
    records.at(-1)?.stop_reason !== null
  ) {
    throw new Error(
      `Invalid result envelope: ${JSON.stringify(records.at(-1))}`,
    )
  }
  console.log('Stream JSON compatibility checks passed.')
} finally {
  await new Promise((resolve) => server.close(resolve)).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}
