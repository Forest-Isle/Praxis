import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import { selectClaudeSchemaAdapter } from '../dist/compatibility/claude/schema.js'
import {
  createClaudeLastPromptEntry,
  translateProviderEvents,
} from '../dist/compatibility/claude/translation.js'
import { ClaudeTranscriptStore } from '../dist/persistence/claude-transcript-store.js'
import { detectClaudeVersion, runClaudeJson } from './lib/claude-probe.mjs'

const markerFromClaude = 'CLAUDE_ORIGIN_7319'
const markerFromPraxisToolResult = 'PRAXIS_TOOL_RESULT_8427'
const markerFromPraxisAssistant = 'PRAXIS_ASSISTANT_4671'
const markerFromPraxisCreated = 'PRAXIS_CREATED_9538'

async function runClaude(args, cwd, configRoot) {
  const result = await runClaudeJson(args, cwd, configRoot)
  if (result.type !== 'result' || result.is_error) {
    throw new Error(`Claude command failed: ${JSON.stringify(result)}`)
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

  const version = await detectClaudeVersion('Compatibility probe')
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
  const praxisToolCallId = `call_${randomUUID().replaceAll('-', '')}`
  const praxisContinuation = translateProviderEvents(
    [
      { type: 'user-text', text: 'Praxis continued this session.' },
      {
        type: 'assistant-tool-call',
        toolCallId: praxisToolCallId,
        name: 'Bash',
        input: { command: 'printf praxis-tool-fixture' },
        providerMessageId: `msg_${randomUUID().replaceAll('-', '')}`,
        model: 'praxis/fixture',
      },
      {
        type: 'tool-result',
        toolCallId: praxisToolCallId,
        content: markerFromPraxisToolResult,
        isError: false,
      },
      {
        type: 'assistant-text',
        text: markerFromPraxisAssistant,
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
  const praxisContinuationLeaf = praxisContinuation.at(-1)?.uuid
  if (typeof praxisContinuationLeaf !== 'string') {
    throw new Error('Praxis continuation has no final assistant leaf')
  }
  await appendEntries(claudeStore, [
    ...praxisContinuation,
    createClaudeLastPromptEntry({
      sessionId: claudeSessionId,
      lastPrompt: 'Praxis continued this session.',
      leafUuid: praxisContinuationLeaf,
    }),
  ])

  const claudeResume = await runClaude(
    [
      '-p',
      '--resume',
      claudeSessionId,
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--output-format',
      'json',
      'Find every distinct token matching PRAXIS_[A-Z0-9_]+ in the immediately prior Praxis-authored tool result and final assistant response. Reply with both tokens and nothing else.',
    ],
    canonicalWorkDirectory,
    configRoot,
  )
  if (
    claudeResume.session_id !== claudeSessionId ||
    !String(claudeResume.result).includes(markerFromPraxisToolResult) ||
    !String(claudeResume.result).includes(markerFromPraxisAssistant)
  ) {
    throw new Error(
      `Claude did not resume the Praxis-appended context: ${JSON.stringify({
        sessionId: claudeResume.session_id,
        result: claudeResume.result,
      })}`,
    )
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
        text: markerFromPraxisCreated,
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
  const praxisOriginLeaf = praxisOrigin.at(-1)?.uuid
  if (typeof praxisOriginLeaf !== 'string') {
    throw new Error('Praxis-created session has no final assistant leaf')
  }
  await appendEntries(praxisStore, [
    ...praxisOrigin,
    createClaudeLastPromptEntry({
      sessionId: praxisSessionId,
      lastPrompt: 'Remember the following marker.',
      leafUuid: praxisOriginLeaf,
    }),
  ])

  const praxisResume = await runClaude(
    [
      '-p',
      '--continue',
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
  if (
    praxisResume.session_id !== praxisSessionId ||
    !String(praxisResume.result).includes(markerFromPraxisCreated)
  ) {
    throw new Error('Claude did not discover the Praxis-created session')
  }

  console.log(
    `Claude ${version} compatibility passed: Claude→Praxis(tool + final response)→Claude and Praxis→Claude discovery`,
  )
} finally {
  await rm(probeRoot, { recursive: true })
}
