import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-model-controls-'))
const requests = []
let structuredTurn = 0

function events(content) {
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_probe_${requests.length}`,
        type: 'message',
        role: 'assistant',
        model: 'fixture-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    },
    ...content.flatMap((block, index) => [
      { type: 'content_block_start', index, content_block: block.start },
      ...(block.delta
        ? [
            {
              type: 'content_block_delta',
              index,
              delta: block.delta,
            },
          ]
        : []),
      { type: 'content_block_stop', index },
    ]),
    {
      type: 'message_delta',
      delta: {
        stop_reason: content.some(({ start }) => start.type === 'tool_use')
          ? 'tool_use'
          : 'end_turn',
        stop_sequence: null,
      },
      usage: { output_tokens: 4 },
    },
    { type: 'message_stop' },
  ]
}

function textEvents(text) {
  return events([
    {
      start: { type: 'text', text: '' },
      delta: { type: 'text_delta', text },
    },
  ])
}

function toolEvents(name, input) {
  return events([
    {
      start: {
        type: 'tool_use',
        id: 'structured_probe',
        name,
        input: {},
      },
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(input),
      },
    },
  ])
}

const server = createServer(async (request, response) => {
  if (request.method === 'HEAD') {
    response.writeHead(200).end()
    return
  }
  let source = ''
  request.setEncoding('utf8')
  for await (const chunk of request) source += chunk
  const body = JSON.parse(source)
  requests.push(body)
  if (body.model === 'primary-probe' || body.model === 'fallback-one') {
    response.writeHead(529, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'probe overloaded' },
      }),
    )
    return
  }
  const structured = body.tools?.find(({ name }) => name === 'StructuredOutput')
  const output = structured
    ? structuredTurn++ === 0
      ? toolEvents('StructuredOutput', { answer: 'ok' })
      : textEvents('structured complete')
    : textEvents('fallback complete')
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    output
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
  if (!address || typeof address === 'string') throw new Error('no address')
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: join(root, 'config'),
    ANTHROPIC_API_KEY: 'fixture-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  const structured = await execFileAsync(
    'claude',
    [
      '-p',
      '--model',
      'structured-probe',
      '--effort',
      'xhigh',
      '--json-schema',
      JSON.stringify({
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      }),
      '--output-format',
      'json',
      'return structured output',
    ],
    { cwd: root, env, timeout: 120_000 },
  )
  const fallback = await execFileAsync(
    'claude',
    [
      '-p',
      '--model',
      'primary-probe',
      '--fallback-model',
      'fallback-one,fallback-two',
      '--output-format',
      'json',
      'exercise fallback',
    ],
    { cwd: root, env, timeout: 120_000 },
  )
  console.log(
    JSON.stringify(
      {
        structuredResult: JSON.parse(structured.stdout),
        fallbackResult: JSON.parse(fallback.stdout),
        requests: requests.map((body) => ({
          model: body.model,
          output_config: body.output_config,
          tools: body.tools?.filter(({ name }) => name === 'StructuredOutput'),
        })),
      },
      null,
      2,
    ),
  )
} finally {
  await new Promise((resolve) => server.close(resolve)).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}
