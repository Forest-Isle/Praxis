import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import {
  parseClaudeVersionOutput,
  selectClaudeSchemaAdapter,
} from '../dist/compatibility/claude/schema.js'
import { translateProviderEvents } from '../dist/compatibility/claude/translation.js'
import { ClaudeTranscriptStore } from '../dist/persistence/claude-transcript-store.js'

const execFileAsync = promisify(execFile)
const markerFromClaude = 'CLAUDE_ORIGIN_7319'
const markerFromPraxis = 'PRAXIS_ORIGIN_8427'

async function runClaude(args, cwd, configRoot) {
  const { stdout } = await execFileAsync('claude', args, {
    cwd,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  })
  const result = JSON.parse(stdout)
  if (result.type !== 'result' || result.is_error) {
    throw new Error(`Claude command failed: ${stdout}`)
  }
  return result
}

async function appendEntries(store, entries) {
  let snapshot = await store.load()
  for (const entry of entries) {
    const result = await store.append(snapshot.tail, entry)
    if (result.status !== 'appended') {
      throw new Error(`Praxis append conflict: ${result.reason}`)
    }
    snapshot = { entries: [], tail: result.tail }
  }
}

const probeRoot = await mkdtemp(join(tmpdir(), 'praxis-claude-compat-'))

try {
  const workDirectory = join(probeRoot, 'work')
  const configRoot = join(probeRoot, 'config')
  await mkdir(workDirectory, { recursive: true })
  const canonicalWorkDirectory = await realpath(workDirectory)

  const { stdout: versionOutput } = await execFileAsync('claude', ['--version'])
  const version = parseClaudeVersionOutput(versionOutput)
  const schema = selectClaudeSchemaAdapter(version)
  if (schema.writeMode !== 'read-write') {
    throw new Error(
      `Claude ${version} is not supported for compatibility writes`,
    )
  }

  const claudeOrigin = await runClaude(
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--output-format',
      'json',
      `Reply with exactly ${markerFromClaude}`,
    ],
    canonicalWorkDirectory,
    configRoot,
  )
  const claudeSessionId = claudeOrigin.session_id
  if (typeof claudeSessionId !== 'string') {
    throw new Error('Claude did not return a session ID')
  }

  const claudePaths = resolveClaudePaths({
    configDir: configRoot,
    cwd: canonicalWorkDirectory,
    sessionId: claudeSessionId,
  })
  const claudeStore = new ClaudeTranscriptStore({
    sessionFile: claudePaths.sessionFile,
    lockFile: join(claudePaths.praxisRoot, 'locks', `${claudeSessionId}.lock`),
    schema,
  })
  const claudeSnapshot = await claudeStore.load()
  const praxisContinuation = translateProviderEvents(
    [
      { type: 'user-text', text: 'Praxis continued this session.' },
      {
        type: 'assistant-text',
        text: markerFromPraxis,
        providerMessageId: `msg_${randomUUID().replaceAll('-', '')}`,
        model: 'praxis/fixture',
      },
    ],
    {
      sessionId: claudeSessionId,
      parentUuid: claudeSnapshot.tail.lastUuid,
      cwd: canonicalWorkDirectory,
      claudeVersion: version,
      gitBranch: null,
    },
  )
  await appendEntries(claudeStore, praxisContinuation)

  const claudeResume = await runClaude(
    [
      '-p',
      '--resume',
      claudeSessionId,
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--output-format',
      'json',
      `Repeat exactly the prior assistant marker ${markerFromPraxis}`,
    ],
    canonicalWorkDirectory,
    configRoot,
  )
  if (!String(claudeResume.result).includes(markerFromPraxis)) {
    throw new Error('Claude did not resume the Praxis-appended context')
  }

  const praxisSessionId = randomUUID()
  const praxisPaths = resolveClaudePaths({
    configDir: configRoot,
    cwd: canonicalWorkDirectory,
    sessionId: praxisSessionId,
  })
  const praxisStore = new ClaudeTranscriptStore({
    sessionFile: praxisPaths.sessionFile,
    lockFile: join(praxisPaths.praxisRoot, 'locks', `${praxisSessionId}.lock`),
    schema,
  })
  const praxisOrigin = translateProviderEvents(
    [
      { type: 'user-text', text: 'Remember the following marker.' },
      {
        type: 'assistant-text',
        text: markerFromPraxis,
        providerMessageId: `msg_${randomUUID().replaceAll('-', '')}`,
        model: 'praxis/fixture',
      },
    ],
    {
      sessionId: praxisSessionId,
      parentUuid: null,
      cwd: canonicalWorkDirectory,
      claudeVersion: version,
      gitBranch: null,
    },
  )
  await appendEntries(praxisStore, praxisOrigin)

  const praxisResume = await runClaude(
    [
      '-p',
      '--resume',
      praxisSessionId,
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--output-format',
      'json',
      'Repeat exactly the marker from the prior assistant response.',
    ],
    canonicalWorkDirectory,
    configRoot,
  )
  if (!String(praxisResume.result).includes(markerFromPraxis)) {
    throw new Error('Claude did not resume the Praxis-created session')
  }

  console.log(
    `Claude ${version} compatibility passed: Claude→Praxis→Claude and Praxis→Claude`,
  )
} finally {
  await rm(probeRoot, { recursive: true })
}
