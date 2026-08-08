import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  detectClaudeVersion,
  execFileAsync,
  runClaudeJson,
} from './lib/claude-probe.mjs'

const root = await mkdtemp(join(tmpdir(), 'praxis-resume-selector-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'work')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function events(text) {
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_${randomUUID().replaceAll('-', '')}`,
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

const server = createServer(async (request, response) => {
  if (request.method === 'HEAD') {
    response.writeHead(200).end()
    return
  }
  for await (const chunk of request) void chunk
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    events('RESUME_SELECTOR_OK')
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
  )
})

function closeServer() {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function expectFailure(command, args, environment, expected) {
  try {
    await execFileAsync(command, args, {
      cwd,
      env: { ...process.env, ...environment },
      timeout: 120_000,
    })
  } catch (error) {
    assert(
      String(error.stderr).includes(expected),
      `missing error: ${expected}`,
    )
    return
  }
  throw new Error(`command unexpectedly succeeded: ${args.join(' ')}`)
}

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})

try {
  await detectClaudeVersion('resume selector compatibility gate')
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(cwd, { recursive: true }),
  ])
  const canonicalCwd = await realpath(cwd)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const praxisEnv = {
    CLAUDE_CONFIG_DIR: configRoot,
    PRAXIS_PROVIDER: 'anthropic',
    PRAXIS_API_KEY: 'fixture-key',
    PRAXIS_MODEL: 'fixture-model',
    PRAXIS_BASE_URL: `${baseUrl}/v1`,
  }
  const claudeEnv = {
    ANTHROPIC_API_KEY: 'fixture-key',
    ANTHROPIC_BASE_URL: baseUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  const praxisCli = join(process.cwd(), 'dist', 'cli.js')
  const praxis = async (args) => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [praxisCli, ...args],
      {
        cwd: canonicalCwd,
        env: { ...process.env, ...praxisEnv },
        timeout: 120_000,
      },
    )
    return JSON.parse(stdout)
  }
  const primaryId = '74747474-7474-4474-8474-747474747474'
  const duplicateIds = [
    '74747474-7474-4474-8474-747474747475',
    '74747474-7474-4474-8474-747474747476',
  ]

  await praxis([
    '-p',
    '--output-format=json',
    '--session-id',
    primaryId,
    '--name',
    'Release Review',
    'create',
  ])
  for (const sessionId of duplicateIds) {
    await praxis([
      '-p',
      '--output-format=json',
      '--session-id',
      sessionId,
      '--name',
      'Duplicate',
      'create',
    ])
  }

  const title = await praxis([
    '-p',
    '--output-format=json',
    '--resume=RELEASE REVIEW',
    'title',
  ])
  assert(
    title.session_id === primaryId,
    'Praxis title selector chose wrong session',
  )
  const uuid = await praxis([
    '-p',
    '--output-format=json',
    `-r${primaryId.toUpperCase()}`,
    'uuid',
  ])
  assert(
    uuid.session_id === primaryId,
    'Praxis UUID selector was not canonicalized',
  )

  const claude = await runClaudeJson(
    [
      '-p',
      '--resume',
      'release review',
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--output-format',
      'json',
      'claude title',
    ],
    canonicalCwd,
    configRoot,
    claudeEnv,
  )
  assert(claude.session_id === primaryId, 'Claude did not resolve Praxis title')

  await expectFailure(
    process.execPath,
    [praxisCli, '-p', '--resume'],
    praxisEnv,
    '--resume requires a valid session ID or session title',
  )
  await expectFailure(
    process.execPath,
    [praxisCli, '-p', '--resume=release', 'missing'],
    praxisEnv,
    'does not match any session title',
  )
  await expectFailure(
    process.execPath,
    [praxisCli, '-p', '--resume=duplicate', 'ambiguous'],
    praxisEnv,
    'matches 2 sessions',
  )
  console.log('Resume selector compatibility gate passed.')
} finally {
  await closeServer()
  await rm(root, { recursive: true, force: true })
}
