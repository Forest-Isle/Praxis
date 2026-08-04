import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClaudeSessionService } from '../dist/application/session-service.js'
import { ClaudePermissionResolver } from '../dist/permissions/claude-permission-resolver.js'
import { detectClaudeVersion, runClaudeJson } from './lib/claude-probe.mjs'

const praxisCreatedMarker = 'PRAXIS_RUNTIME_CREATED_1742'
const praxisResumedMarker = 'PRAXIS_RUNTIME_RESUMED_6835'
const claudeOriginMarker = 'CLAUDE_RUNTIME_ORIGIN_9214'
const toolResultMarker = 'PRAXIS_RUNTIME_TOOL_RESULT_3158'
const toolFinalMarker = 'PRAXIS_RUNTIME_TOOL_FINAL_7462'

function fixtureProvider(responses) {
  return {
    model: 'praxis/fixture',
    capabilities: { streaming: true, usage: true, tools: false },
    async *complete(request) {
      const response = responses.shift()
      if (!response) throw new Error('Runtime provider fixture exhausted')
      if (
        response.expectedHistory &&
        !request.messages.some((message) =>
          message.content.includes(response.expectedHistory),
        )
      ) {
        throw new Error('Claude history did not reach the Praxis provider')
      }
      yield { type: 'text-delta', delta: response.text }
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

async function assertClaudeRecallsToolTurn(sessionId, cwd, configRoot) {
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
      'Reply with every distinct token matching PRAXIS_RUNTIME_TOOL_[A-Z0-9_]+ from the prior tool result and final assistant response.',
    ],
    cwd,
    configRoot,
  )
  if (
    result.session_id !== sessionId ||
    !String(result.result).includes(toolResultMarker) ||
    !String(result.result).includes(toolFinalMarker)
  ) {
    throw new Error(
      `Claude did not recover Praxis runtime tool output: ${JSON.stringify(result)}`,
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
    provider: fixtureProvider([
      { text: praxisCreatedMarker },
      {
        text: praxisResumedMarker,
        expectedHistory: claudeOriginMarker,
      },
    ]),
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

  let toolTurn = 0
  const permissionResolver = new ClaudePermissionResolver({
    cwd,
    settings: [
      {
        path: join(configRoot, 'settings.json'),
        scope: 'user',
        value: {
          permissions: {
            allow: ['Read'],
            deny: [`Read(/${cwd}/blocked/**)`],
          },
        },
      },
    ],
  })
  const deniedFixture = await permissionResolver.resolve({
    id: 'call_denied_fixture',
    name: 'Read',
    input: { file_path: join(cwd, 'blocked', 'secret.txt') },
  })
  const askedFixture = await permissionResolver.resolve({
    id: 'call_asked_fixture',
    name: 'Write',
    input: { file_path: join(cwd, 'output.txt') },
  })
  if (deniedFixture.behavior !== 'deny' || askedFixture.behavior !== 'ask') {
    throw new Error('Claude-compatible permission fixture did not match')
  }
  const toolService = new ClaudeSessionService({
    configRoot,
    cwd,
    claudeVersion,
    provider: {
      model: 'praxis/fixture',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        if (toolTurn++ === 0) {
          yield {
            type: 'tool-call',
            call: {
              id: 'call_runtime_fixture',
              name: 'Read',
              input: { file_path: 'fixture.txt' },
            },
          }
          return
        }
        if (
          !request.messages.some(
            (message) =>
              message.role === 'tool' &&
              message.content.includes(toolResultMarker),
          )
        ) {
          throw new Error('Tool result did not reach the Praxis provider')
        }
        yield { type: 'text-delta', delta: toolFinalMarker }
      },
    },
    tools: {
      definitions: () => [
        {
          name: 'Read',
          description: 'Read a fixture',
          inputSchema: { type: 'object' },
        },
      ],
      async prepare(call) {
        return call
      },
      async execute() {
        return { content: toolResultMarker, isError: false }
      },
    },
    permissions: permissionResolver,
  })
  const toolRuntime = await toolService.run('Execute the fixture tool.')
  if (toolRuntime.text !== toolFinalMarker) {
    throw new Error('Praxis tool runtime did not produce the final marker')
  }
  await assertClaudeRecallsToolTurn(toolRuntime.sessionId, cwd, configRoot)
  const toolFork = await toolService.fork(toolRuntime.sessionId)
  await assertClaudeRecallsToolTurn(toolFork.sessionId, cwd, configRoot)

  console.log(
    `Claude ${claudeVersion} runtime compatibility passed: Praxis→Claude, fork→Claude, Claude→Praxis→Claude, Praxis tool loop→Claude, and native tool fork→Claude`,
  )
} finally {
  await rm(probeRoot, { recursive: true })
}
