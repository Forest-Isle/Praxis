import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClaudeSessionService } from '../dist/application/session-service.js'
import { detectClaudeVersion, runClaudeJson } from './lib/claude-probe.mjs'

const praxisCreatedMarker = 'PRAXIS_RUNTIME_CREATED_1742'
const praxisResumedMarker = 'PRAXIS_RUNTIME_RESUMED_6835'
const claudeOriginMarker = 'CLAUDE_RUNTIME_ORIGIN_9214'

function fixtureProvider(responses) {
  return {
    model: 'praxis/fixture',
    capabilities: { streaming: true, usage: true },
    async *complete() {
      const text = responses.shift()
      if (!text) throw new Error('Runtime provider fixture exhausted')
      yield { type: 'text-delta', delta: text }
      yield {
        type: 'usage',
        usage: { inputTokens: 1, outputTokens: 1 },
      }
    },
  }
}

async function runClaude(args, cwd, configRoot) {
  const result = await runClaudeJson(args, cwd, configRoot)
  if (result.type !== 'result' || result.is_error) {
    throw new Error(`Claude command failed: ${JSON.stringify(result)}`)
  }
  return result
}

async function assertClaudeRecalls(sessionId, marker, cwd, configRoot) {
  const result = await runClaude(
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
      'Reply with exactly the most recent historical token matching PRAXIS_RUNTIME_[A-Z0-9_]+.',
    ],
    cwd,
    configRoot,
  )
  if (
    result.session_id !== sessionId ||
    !String(result.result).includes(marker)
  ) {
    throw new Error(
      `Claude did not recover Praxis runtime output: ${JSON.stringify(result)}`,
    )
  }
}

const probeRoot = await mkdtemp(join(tmpdir(), 'praxis-runtime-compat-'))

try {
  const configRoot = join(probeRoot, 'config')
  const workDirectory = join(probeRoot, 'work')
  await mkdir(workDirectory, { recursive: true })
  const cwd = await realpath(workDirectory)
  const claudeVersion = await detectClaudeVersion('Runtime probe')
  const service = new ClaudeSessionService({
    configRoot,
    cwd,
    claudeVersion,
    provider: fixtureProvider([praxisCreatedMarker, praxisResumedMarker]),
  })

  const praxisCreated = await service.run(
    'Create a runtime compatibility turn.',
  )
  await assertClaudeRecalls(
    praxisCreated.sessionId,
    praxisCreatedMarker,
    cwd,
    configRoot,
  )
  const forked = await service.fork(praxisCreated.sessionId)
  await assertClaudeRecalls(
    forked.sessionId,
    praxisCreatedMarker,
    cwd,
    configRoot,
  )

  const claudeOrigin = await runClaude(
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--output-format',
      'json',
      `Reply with exactly ${claudeOriginMarker}`,
    ],
    cwd,
    configRoot,
  )
  if (typeof claudeOrigin.session_id !== 'string') {
    throw new Error('Claude runtime origin has no session ID')
  }

  const resumed = await service.resume(
    claudeOrigin.session_id,
    'Continue this session from the Praxis runtime.',
  )
  if (resumed.text !== praxisResumedMarker) {
    throw new Error(
      'Praxis runtime did not complete the Claude-created session',
    )
  }
  await assertClaudeRecalls(
    claudeOrigin.session_id,
    praxisResumedMarker,
    cwd,
    configRoot,
  )

  console.log(
    `Claude ${claudeVersion} runtime compatibility passed: Praxis→Claude, fork→Claude, and Claude→Praxis→Claude`,
  )
} finally {
  await rm(probeRoot, { recursive: true })
}
