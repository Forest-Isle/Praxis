import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import { selectClaudeSchemaAdapter } from '../dist/compatibility/claude/schema.js'
import { ClaudeTranscriptStore } from '../dist/persistence/claude-transcript-store.js'
import {
  detectClaudeVersion,
  execFileAsync,
  runClaudeJson,
} from './lib/claude-probe.mjs'

const root = await mkdtemp(join(tmpdir(), 'praxis-pr-link-compat-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'work')
const claudeMarker = 'CLAUDE_PR_LINK_ORIGIN_5901'
const praxisMarker = 'PRAXIS_FROM_PR_APPEND_5902'
const forkSessionId = '99999999-9999-4999-8999-999999999999'
const providerRequests = []

function textEvents(text) {
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_pr_${randomUUID().replaceAll('-', '')}`,
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
  if (!request.url?.startsWith('/v1/messages')) {
    response.writeHead(404).end()
    return
  }
  let source = ''
  request.setEncoding('utf8')
  for await (const chunk of request) source += chunk
  providerRequests.push(JSON.parse(source))
  const events = textEvents(praxisMarker)
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
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function closeServer() {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

try {
  const version = await detectClaudeVersion('PR link compatibility probe')
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(configRoot, { recursive: true }),
  ])
  const canonicalCwd = await realpath(cwd)
  const claudeOrigin = await runClaudeJson(
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--output-format',
      'json',
      `Reply with exactly ${claudeMarker}`,
    ],
    canonicalCwd,
    configRoot,
  )
  if (
    claudeOrigin.type !== 'result' ||
    claudeOrigin.is_error ||
    typeof claudeOrigin.session_id !== 'string'
  ) {
    throw new Error(`Claude origin failed: ${JSON.stringify(claudeOrigin)}`)
  }
  const sourceSessionId = claudeOrigin.session_id
  const schema = selectClaudeSchemaAdapter(version)
  const sourcePaths = resolveClaudePaths({
    configDir: configRoot,
    cwd: canonicalCwd,
    sessionId: sourceSessionId,
  })
  const sourceStore = new ClaudeTranscriptStore({
    sessionFile: sourcePaths.sessionFile,
    lockFile: join(sourcePaths.praxisRoot, 'locks', `${sourceSessionId}.lock`),
    schema,
  })
  const sourceSnapshot = await sourceStore.load()
  const prLink = {
    type: 'pr-link',
    sessionId: sourceSessionId,
    prNumber: 42,
    prUrl: 'https://github.com/owner/repo/pull/42',
    prRepository: 'owner/repo',
    timestamp: new Date().toISOString(),
  }
  const linked = await sourceStore.append(sourceSnapshot.tail, prLink)
  if (linked.status !== 'appended') {
    throw new Error(`Could not append native PR link: ${linked.reason}`)
  }

  await listen()
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('PR link fixture server has no TCP address')
  }
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), 'dist/cli.js'),
      '-p',
      '--output-format=json',
      '--from-pr=owner/repo#42',
      '--fork-session',
      '--session-id',
      forkSessionId,
      '--',
      'continue the linked session',
    ],
    {
      cwd: canonicalCwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_API_KEY: 'fixture-key',
        PRAXIS_MODEL: 'fixture-model',
        PRAXIS_BASE_URL: baseUrl,
      },
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  const praxisResult = JSON.parse(stdout)
  if (
    praxisResult.type !== 'result' ||
    praxisResult.is_error ||
    praxisResult.session_id !== forkSessionId ||
    praxisResult.result !== praxisMarker
  ) {
    throw new Error(`Praxis --from-pr failed: ${stdout}`)
  }
  if (!JSON.stringify(providerRequests[0]).includes(claudeMarker)) {
    throw new Error('--from-pr did not resume Claude-generated history')
  }

  const forkPaths = resolveClaudePaths({
    configDir: configRoot,
    cwd: canonicalCwd,
    sessionId: forkSessionId,
  })
  const forkStore = new ClaudeTranscriptStore({
    sessionFile: forkPaths.sessionFile,
    lockFile: join(forkPaths.praxisRoot, 'locks', `${forkSessionId}.lock`),
    schema,
  })
  const forkSnapshot = await forkStore.load()
  const forkPrLink = forkSnapshot.entries.find(
    (entry) => entry.type === 'pr-link',
  )
  if (
    forkPrLink?.sessionId !== forkSessionId ||
    forkPrLink.prNumber !== 42 ||
    forkPrLink.prRepository !== 'owner/repo'
  ) {
    throw new Error('Fork did not preserve native PR link metadata')
  }

  const claudeResume = await runClaudeJson(
    [
      '-p',
      '--resume',
      forkSessionId,
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--output-format',
      'json',
      `Repeat exactly ${praxisMarker}`,
    ],
    canonicalCwd,
    configRoot,
  )
  if (
    claudeResume.type !== 'result' ||
    claudeResume.is_error ||
    claudeResume.session_id !== forkSessionId ||
    !String(claudeResume.result).includes(praxisMarker)
  ) {
    throw new Error(
      `Claude did not resume the PR-linked Praxis fork: ${JSON.stringify(claudeResume)}`,
    )
  }

  console.log(
    `Claude ${version} PR-link compatibility passed: native metadata projection, --from-pr selection, fork preservation, and Claude resume.`,
  )
} finally {
  await closeServer().catch(() => undefined)
  await rm(root, { recursive: true })
}
