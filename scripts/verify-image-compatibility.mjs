import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import { projectClaudeModelMessages } from '../dist/compatibility/claude/projection.js'
import { selectClaudeSchemaAdapter } from '../dist/compatibility/claude/schema.js'
import {
  createClaudeLastPromptEntry,
  translateProviderEvents,
} from '../dist/compatibility/claude/translation.js'
import { ClaudeTranscriptStore } from '../dist/persistence/claude-transcript-store.js'
import {
  assertContains,
  detectClaudeVersion,
  execFileAsync,
  runClaudeJson,
  writeFixture,
} from './lib/claude-probe.mjs'

const imageData =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='
const praxisResumeMarker = 'PRAXIS_IMAGE_RESUME_OK'

async function appendEntries(store, entries) {
  let snapshot = await store.load()
  for (const entry of entries) {
    const result = await store.append(snapshot.tail, entry)
    if (result.status !== 'appended') {
      throw new Error(`Praxis image append conflict: ${result.reason}`)
    }
    snapshot = { entries: [], tail: result.tail }
  }
}

async function installClaudeImageFixture(configRoot, cwd, sessionId) {
  const source = await readFile(
    new URL(
      '../test/fixtures/claude-code/2.1.208/media-error-session.jsonl',
      import.meta.url,
    ),
    'utf8',
  )
  const content = `${source
    .trimEnd()
    .split('\n')
    .map((line) => {
      const entry = JSON.parse(line)
      entry.sessionId = sessionId
      entry.cwd = cwd
      return JSON.stringify(entry)
    })
    .join('\n')}\n`
  const paths = resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
  await writeFixture(paths.sessionFile, content)
}

async function startOpenAIProbeServer() {
  let providerRequest
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    providerRequest = {
      method: request.method,
      url: request.url,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      connection: 'close',
    })
    response.end(
      `data: ${JSON.stringify({
        choices: [
          {
            delta: { content: praxisResumeMarker },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })}\n\ndata: [DONE]\n\n`,
    )
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Image provider probe did not bind a TCP port')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    request: () => providerRequest,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

const probeRoot = await mkdtemp(join(tmpdir(), 'praxis-image-compat-'))

try {
  const workDirectory = join(probeRoot, 'work')
  const configRoot = join(probeRoot, 'config')
  await mkdir(workDirectory, { recursive: true })
  const cwd = await realpath(workDirectory)
  const version = await detectClaudeVersion('Image compatibility probe')
  const schema = selectClaudeSchemaAdapter(version)
  if (version !== '2.1.208' || schema.writeMode !== 'read-write') {
    throw new Error(
      `Image compatibility probe does not support Claude ${version}`,
    )
  }

  const sessionId = randomUUID()
  const paths = resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
  const store = new ClaudeTranscriptStore({
    sessionFile: paths.sessionFile,
    lockFile: join(paths.praxisRoot, 'locks', `${sessionId}.lock`),
    schema,
  })
  const entries = translateProviderEvents(
    [
      { type: 'user-text', text: 'Inspect the image fixture.' },
      {
        type: 'assistant-tool-call',
        toolCallId: 'call_image_fixture',
        name: 'Read',
        input: { file_path: join(cwd, 'pixel.png') },
        providerMessageId: `msg_${randomUUID().replaceAll('-', '')}`,
        model: 'praxis/fixture',
      },
      {
        type: 'tool-result',
        toolCallId: 'call_image_fixture',
        content: '',
        images: [{ type: 'image', mediaType: 'image/png', data: imageData }],
        isError: false,
      },
      {
        type: 'assistant-text',
        text: 'The Read tool returned an image.',
        providerMessageId: `msg_${randomUUID().replaceAll('-', '')}`,
        model: 'praxis/fixture',
      },
    ],
    {
      sessionId,
      parentUuid: null,
      cwd,
      claudeVersion: version,
      gitBranch: null,
    },
  )
  const leafUuid = entries.at(-1)?.uuid
  if (typeof leafUuid !== 'string') {
    throw new Error('Praxis image fixture has no assistant leaf')
  }
  await appendEntries(store, [
    ...entries,
    createClaudeLastPromptEntry({
      sessionId,
      lastPrompt: 'Inspect the image fixture.',
      leafUuid,
    }),
  ])

  const projected = projectClaudeModelMessages((await store.load()).entries)
  const image = projected.find(
    (message) => message.role === 'tool' && message.images?.length === 1,
  )
  if (image?.images?.[0]?.data !== imageData) {
    throw new Error('Praxis could not project its native image tool result')
  }

  const response = await runClaudeJson(
    [
      '-p',
      '--resume',
      sessionId,
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--output-format',
      'json',
      'The prior Read tool result contains an image. Reply exactly IMAGE_WRITER_OK.',
    ],
    cwd,
    configRoot,
  )
  if (
    response.type !== 'result' ||
    response.is_error ||
    response.session_id !== sessionId
  ) {
    throw new Error(
      `Claude failed to resume Praxis image session: ${JSON.stringify(response)}`,
    )
  }
  assertContains(
    String(response.result),
    'IMAGE_WRITER_OK',
    'Claude image resume',
  )

  const claudeFixtureSessionId = randomUUID()
  await installClaudeImageFixture(configRoot, cwd, claudeFixtureSessionId)
  const providerProbe = await startOpenAIProbeServer()
  let praxisOutput
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        fileURLToPath(new URL('../dist/cli.js', import.meta.url)),
        'resume',
        '--json',
        claudeFixtureSessionId,
        'Resume the Claude image fixture.',
      ],
      {
        cwd,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: configRoot,
          PRAXIS_PROVIDER: 'openai',
          PRAXIS_API_KEY: 'image-probe-key',
          PRAXIS_MODEL: 'praxis-image-probe',
          PRAXIS_BASE_URL: providerProbe.baseUrl,
        },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
      },
    )
    praxisOutput = result.stdout
  } finally {
    await providerProbe.close()
  }
  const providerRequest = providerProbe.request()
  if (
    providerRequest?.method !== 'POST' ||
    providerRequest.url !== '/v1/chat/completions' ||
    !providerRequest.body.messages.some(
      (message) =>
        message.role === 'user' &&
        Array.isArray(message.content) &&
        message.content.some(
          (block) =>
            block.type === 'image_url' &&
            block.image_url?.url === `data:image/png;base64,${imageData}`,
        ),
    )
  ) {
    throw new Error('Praxis did not send the Claude image fixture to provider')
  }
  const praxisResult = praxisOutput
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
    .findLast((entry) => entry.type === 'result')
  if (
    praxisResult?.sessionId !== claudeFixtureSessionId ||
    praxisResult.text !== praxisResumeMarker
  ) {
    throw new Error(`Praxis image resume failed: ${praxisOutput}`)
  }
  const reversePaths = resolveClaudePaths({
    configDir: configRoot,
    cwd,
    sessionId: claudeFixtureSessionId,
  })
  const reverseStore = new ClaudeTranscriptStore({
    sessionFile: reversePaths.sessionFile,
    lockFile: join(
      reversePaths.praxisRoot,
      'locks',
      `${claudeFixtureSessionId}.lock`,
    ),
    schema,
  })
  if (
    !projectClaudeModelMessages((await reverseStore.load()).entries).some(
      (message) =>
        message.role === 'assistant' && message.content === praxisResumeMarker,
    )
  ) {
    throw new Error('Praxis did not append its image resume marker')
  }
  const claudeReverseResponse = await runClaudeJson(
    [
      '-p',
      '--resume',
      claudeFixtureSessionId,
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--output-format',
      'json',
      'Reply exactly with the most recent historical token matching PRAXIS_IMAGE_[A-Z0-9_]+.',
    ],
    cwd,
    configRoot,
  )
  if (
    claudeReverseResponse.type !== 'result' ||
    claudeReverseResponse.is_error ||
    claudeReverseResponse.session_id !== claudeFixtureSessionId
  ) {
    throw new Error(
      `Claude failed to resume Praxis-appended image fixture: ${JSON.stringify(claudeReverseResponse)}`,
    )
  }
  assertContains(
    String(claudeReverseResponse.result),
    praxisResumeMarker,
    'Claude reverse image resume',
  )

  console.log(
    `Claude ${version} image compatibility passed: Praxis writer → Praxis projection → Claude resume and Claude fixture → Praxis provider → Praxis append → Claude resume`,
  )
} finally {
  await rm(probeRoot, { recursive: true })
}
