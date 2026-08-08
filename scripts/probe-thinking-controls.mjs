import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-thinking-controls-'))
const requests = []

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
  requests.push({
    headers: request.headers,
    body: JSON.parse(source),
  })
  const events = [
    {
      type: 'message_start',
      message: {
        id: `msg_thinking_${requests.length}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5-20250929',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'private thought' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'fixture-signature' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'ok' },
    },
    { type: 'content_block_stop', index: 1 },
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
  if (!address || typeof address === 'string') throw new Error('no address')
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: join(root, 'config'),
    ANTHROPIC_API_KEY: 'fixture-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  const cases = [
    ['sonnet-45-default', 'claude-sonnet-4-5-20250929'],
    [
      'sonnet-45-adaptive',
      'claude-sonnet-4-5-20250929',
      '--thinking',
      'adaptive',
    ],
    [
      'sonnet-45-disabled',
      'claude-sonnet-4-5-20250929',
      '--thinking',
      'disabled',
    ],
    ['sonnet-46-default', 'claude-sonnet-4-6'],
    ['sonnet-46-enabled', 'claude-sonnet-4-6', '--thinking', 'enabled'],
    ['sonnet-46-adaptive', 'claude-sonnet-4-6', '--thinking', 'adaptive'],
    ['sonnet-46-disabled', 'claude-sonnet-4-6', '--thinking', 'disabled'],
    ['opus-46-default', 'claude-opus-4-6'],
    ['opus-46-enabled', 'claude-opus-4-6', '--thinking', 'enabled'],
    ['opus-46-adaptive', 'claude-opus-4-6', '--thinking', 'adaptive'],
    ['opus-46-disabled', 'claude-opus-4-6', '--thinking', 'disabled'],
    ['haiku-45-default', 'claude-haiku-4-5-20251001'],
    [
      'haiku-45-disabled',
      'claude-haiku-4-5-20251001',
      '--thinking',
      'disabled',
    ],
    [
      'opus-46-max',
      'claude-opus-4-6',
      '--thinking',
      'enabled',
      '--max-thinking-tokens',
      '2048',
    ],
    ['opus-46-env-max', 'claude-opus-4-6', '--thinking', 'enabled'],
    [
      'opus-46-effort-low',
      'claude-opus-4-6',
      '--effort',
      'low',
      '--thinking',
      'adaptive',
    ],
  ]
  const results = []
  for (const [name, model, ...controlArgs] of cases) {
    const before = requests.length
    try {
      const execution = await execFileAsync(
        'claude',
        [
          '--bare',
          '-p',
          '--model',
          model,
          '--max-turns',
          '1',
          '--tools=',
          '--no-session-persistence',
          '--output-format',
          'json',
          ...controlArgs,
          'probe',
        ],
        {
          cwd: root,
          env:
            name === 'opus-46-env-max'
              ? { ...env, MAX_THINKING_TOKENS: '2048' }
              : env,
          timeout: 30_000,
        },
      )
      const captured = requests[before]
      results.push({
        name,
        status: 'success',
        request: captured
          ? {
              thinking: captured.body.thinking,
              max_tokens: captured.body.max_tokens,
              output_config: captured.body.output_config,
              betas: captured.headers['anthropic-beta'],
            }
          : null,
        result: JSON.parse(execution.stdout).result,
      })
    } catch (error) {
      results.push({
        name,
        status: 'error',
        stdout: error.stdout,
        stderr: error.stderr,
        request: requests[before]?.body ?? null,
      })
    }
  }
  const sessionId = '63333333-3333-4333-8333-333333333333'
  const streamExecution = await execFileAsync(
    'claude',
    [
      '--bare',
      '-p',
      '--model',
      'claude-sonnet-4-5-20250929',
      '--thinking',
      'enabled',
      '--session-id',
      sessionId,
      '--max-turns',
      '1',
      '--tools=',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      'probe stream output',
    ],
    { cwd: root, env, timeout: 30_000 },
  )
  const configFiles = await readdir(join(root, 'config'), {
    recursive: true,
    withFileTypes: true,
  })
  const transcript = configFiles.find(
    (entry) => entry.isFile() && entry.name === `${sessionId}.jsonl`,
  )
  const transcriptEntries = transcript
    ? (await readFile(join(transcript.parentPath, transcript.name), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : []
  results.push({
    name: 'stream-and-transcript',
    output: streamExecution.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    transcriptAssistantContent: transcriptEntries
      .filter((entry) => entry.type === 'assistant')
      .map((entry) => entry.message?.content),
  })
  console.log(JSON.stringify(results, null, 2))
} finally {
  await new Promise((resolve) => server.close(resolve)).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}
