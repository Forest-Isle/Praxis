import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-auto-mode-'))
const requests = []
let failure

function stream(response, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
  )
}

function textEvents(text) {
  return [
    {
      type: 'message_start',
      message: { usage: { input_tokens: 1, output_tokens: 0 } },
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

function toolEvents() {
  const input = {
    description: 'Run a local script',
    prompt: 'Run node safely',
    subagent_type: 'general-purpose',
    run_in_background: false,
  }
  return [
    {
      type: 'message_start',
      message: { usage: { input_tokens: 1, output_tokens: 0 } },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'auto_agent',
        name: 'Agent',
        input: {},
      },
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

const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/messages') {
      response.writeHead(404).end()
      return
    }
    let source = ''
    request.setEncoding('utf8')
    for await (const chunk of request) source += chunk
    const body = JSON.parse(source)
    requests.push(body)
    const serialized = JSON.stringify(body.messages)
    if (
      body.system?.includes('Praxis permission auto-mode classifier') ||
      body.messages?.[0]?.content?.includes(
        'Praxis permission auto-mode classifier',
      )
    ) {
      stream(
        response,
        textEvents('{"behavior":"allow","reason":"local development action"}'),
      )
    } else if (serialized.includes('AUTO_CHILD_DONE')) {
      stream(response, textEvents('AUTO_MAIN_DONE'))
    } else if (serialized.includes('Delegate through Agent')) {
      stream(response, toolEvents())
    } else if (serialized.includes('Run node safely')) {
      stream(response, textEvents('AUTO_CHILD_DONE'))
    } else {
      stream(response, textEvents('AUTO_MAIN_DONE'))
    }
  } catch (error) {
    failure ??= error
    response.writeHead(500).end()
  }
})

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('No fixture address')
  const configRoot = join(root, 'config')
  const cwd = join(root, 'workspace')
  await mkdir(configRoot, { recursive: true })
  await mkdir(cwd, { recursive: true })
  const defaults = JSON.parse(
    (
      await execFileAsync('node', ['dist/cli.js', 'auto-mode', 'defaults'], {
        cwd: process.cwd(),
        env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot },
      })
    ).stdout,
  )
  if (!Array.isArray(defaults.allow) || !Array.isArray(defaults.hard_deny)) {
    throw new Error(
      `Auto-mode defaults command mismatch: ${JSON.stringify(defaults)}`,
    )
  }
  await writeFile(
    join(configRoot, 'settings.json'),
    JSON.stringify({
      autoMode: { allow: ['fixture allow'], classifyAllShell: true },
    }),
  )
  const config = JSON.parse(
    (
      await execFileAsync('node', ['dist/cli.js', 'auto-mode', 'config'], {
        cwd: process.cwd(),
        env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot },
      })
    ).stdout,
  )
  if (
    !config.allow.includes('fixture allow') ||
    config.classifyAllShell !== true
  ) {
    throw new Error(
      `Auto-mode config command mismatch: ${JSON.stringify(config)}`,
    )
  }
  const result = await execFileAsync(
    'node',
    [
      'dist/cli.js',
      'run',
      '--json',
      '--permission-mode',
      'auto',
      '--tools=Agent',
      'Delegate through Agent',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_API_KEY: 'fixture-key',
        PRAXIS_MODEL: 'fixture-model',
        PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      },
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  const output = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((record) => record.type === 'result')
  if (failure) throw failure
  if (
    output.text !== 'AUTO_MAIN_DONE' ||
    requests.length !== 4 ||
    !requests.some(
      (request) =>
        request.system?.includes('Praxis permission auto-mode classifier') ||
        request.messages?.[0]?.content?.includes(
          'Praxis permission auto-mode classifier',
        ),
    )
  ) {
    throw new Error(
      `Auto-mode CLI contract mismatch: ${JSON.stringify({ output, requests: requests.length })}`,
    )
  }
  console.log(
    'Praxis auto-mode compatibility passed: classifier request, Agent allow, and continuation',
  )
} finally {
  await new Promise((resolve) => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
}
