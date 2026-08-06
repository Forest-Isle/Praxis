import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-worktree-probe-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'repo')
const requests = []
const mode = process.env.PRAXIS_WORKTREE_PROBE_MODE ?? 'schema'
let turn = 0

function textEvents(text) {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_worktree_probe',
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
}

function toolEvents(id, name, input) {
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_worktree_tool_${turn}`,
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
      content_block: { type: 'tool_use', id, name, input: {} },
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

const provider = createServer(async (request, response) => {
  if (request.method === 'HEAD') {
    response.writeHead(200).end()
    return
  }
  let source = ''
  request.setEncoding('utf8')
  for await (const chunk of request) source += chunk
  const body = JSON.parse(source)
  requests.push({
    tools: body.tools?.filter(({ name }) =>
      ['EnterWorktree', 'ExitWorktree'].includes(name),
    ),
    messages: body.messages,
  })
  const hasEnterResult = JSON.stringify(body.messages ?? []).includes(
    'worktree_enter_probe',
  )
  const hasExitResult = JSON.stringify(body.messages ?? []).includes(
    'worktree_exit_probe',
  )
  const events =
    mode === 'lifecycle' && !hasEnterResult
      ? toolEvents('worktree_enter_probe', 'EnterWorktree', {
          name: 'stage25-probe',
        })
      : mode === 'lifecycle' && !hasExitResult
        ? toolEvents('worktree_exit_probe', 'ExitWorktree', {
            action: 'remove',
          })
        : textEvents('WORKTREE_SCHEMA_CAPTURED')
  turn += 1
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
    provider.once('error', reject)
    provider.listen(0, '127.0.0.1', resolve)
  })
}

async function snapshot(directory, base = directory) {
  const entries = []
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const metadata = await stat(path)
    if (metadata.isDirectory()) entries.push(...(await snapshot(path, base)))
    else {
      entries.push({
        path: path.slice(base.length + 1),
        source:
          metadata.size <= 128 * 1024
            ? await readFile(path, 'utf8')
            : '<large>',
      })
    }
  }
  return entries
}

try {
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(cwd, { recursive: true }),
    listen(),
  ])
  await writeFile(join(cwd, 'tracked.txt'), 'base\n')
  await execFileAsync('git', ['init', cwd])
  await execFileAsync('git', ['-C', cwd, 'add', 'tracked.txt'])
  await execFileAsync('git', [
    '-C',
    cwd,
    '-c',
    'user.name=Praxis Probe',
    '-c',
    'user.email=praxis@example.invalid',
    'commit',
    '-m',
    'fixture',
  ])
  const address = provider.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  await execFileAsync(
    'claude',
    [
      '-p',
      ...(mode === 'cli' ? ['--worktree', 'stage25-cli-probe'] : []),
      ...(mode === 'lifecycle' &&
      process.env.PRAXIS_WORKTREE_PROBE_BYPASS !== '0'
        ? ['--dangerously-skip-permissions']
        : []),
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      mode === 'lifecycle' ? '5' : '1',
      '--output-format',
      'json',
      'return worktree schema marker',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      timeout: 120_000,
    },
  )
  console.log(
    JSON.stringify({ requests, files: await snapshot(root) }, null, 2),
  )
} finally {
  await new Promise((resolve) => provider.close(resolve)).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}
