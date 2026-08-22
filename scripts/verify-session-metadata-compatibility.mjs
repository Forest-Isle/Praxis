import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClaudeSessionService } from '../dist/application/session-service.js'
import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import { selectClaudeSchemaAdapter } from '../dist/compatibility/claude/schema.js'
import { ClaudeTranscriptStore } from '../dist/persistence/claude-transcript-store.js'
import { detectClaudeVersion, runClaudeJson } from './lib/claude-probe.mjs'

const EXPECTED_CLAUDE_VERSION = '2.1.237'
const root = await mkdtemp(join(tmpdir(), 'praxis-session-metadata-compat-'))
const configRoot = join(root, 'config')
const work = join(root, 'work')
const praxisMarker = 'PRAXIS_METADATA_ORIGIN_131'
const claudeMarker = 'CLAUDE_METADATA_RESUME_131'
const server = createServer(async (request, response) => {
  if (request.method === 'HEAD') {
    response.writeHead(200).end()
    return
  }
  for await (const chunk of request) void chunk
  if (!request.url?.startsWith('/v1/messages')) {
    response.writeHead(404).end()
    return
  }
  const events = [
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
      delta: { type: 'text_delta', text: claudeMarker },
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

function closeServer() {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

try {
  const version = await detectClaudeVersion('session metadata compatibility')
  if (version !== EXPECTED_CLAUDE_VERSION) {
    throw new Error(
      `Session metadata compatibility requires Claude ${EXPECTED_CLAUDE_VERSION}; received ${version}`,
    )
  }
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(work, { recursive: true }),
  ])
  const cwd = await realpath(work)
  const service = new ClaudeSessionService({
    configRoot,
    cwd,
    claudeVersion: version,
    provider: {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        yield { type: 'text-delta', delta: praxisMarker }
      },
    },
  })
  const origin = await service.run('Create a metadata compatibility session.')
  await service.rename(origin.sessionId, 'Praxis Metadata Fixture')
  await service.tag(origin.sessionId, 'compat-131')

  const paths = resolveClaudePaths({
    configDir: configRoot,
    cwd,
    sessionId: origin.sessionId,
  })
  const schema = selectClaudeSchemaAdapter(version)
  const store = new ClaudeTranscriptStore({
    sessionFile: paths.sessionFile,
    lockFile: join(paths.praxisRoot, 'locks', `${origin.sessionId}.lock`),
    schema,
  })
  let snapshot = await store.load()
  for (const entry of [
    { type: 'ai-title', aiTitle: 'Regeneratable AI title' },
    { type: 'mode', mode: 'acceptEdits' },
  ]) {
    const appended = await store.append(snapshot.tail, {
      ...entry,
      sessionId: origin.sessionId,
    })
    if (appended.status !== 'appended') {
      throw new Error(`Could not append ${entry.type}: ${appended.reason}`)
    }
    snapshot = await store.load()
  }
  await service.close()

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No TCP address')
  const result = await runClaudeJson(
    [
      '-p',
      '--resume',
      origin.sessionId,
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--output-format',
      'json',
      `The prior assistant marker was ${praxisMarker}. Reply exactly ${claudeMarker}.`,
    ],
    cwd,
    configRoot,
    {
      ANTHROPIC_API_KEY: 'fixture-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    },
  )
  if (
    result.type !== 'result' ||
    result.is_error ||
    result.session_id !== origin.sessionId ||
    !String(result.result).includes(claudeMarker)
  ) {
    throw new Error(
      `Claude rejected Praxis metadata: ${JSON.stringify(result)}`,
    )
  }

  const resumed = await store.load()
  for (const type of ['custom-title', 'tag', 'ai-title', 'mode']) {
    if (!resumed.entries.some((entry) => entry.type === type)) {
      throw new Error(`Claude resume did not preserve ${type}`)
    }
  }
  console.log(
    `Claude ${version} session metadata compatibility passed: Praxis custom-title, tag, ai-title, mode, and durable snapshots resumed and remained parseable.`,
  )
} finally {
  await closeServer().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}
