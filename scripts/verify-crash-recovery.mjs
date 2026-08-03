import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClaudeSessionService } from '../dist/application/session-service.js'
import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import { AgentRunCancelledError } from '../dist/core/runtime.js'
import { detectClaudeVersion, runClaudeJson } from './lib/claude-probe.mjs'

const recoveryMarker = 'PRAXIS_RECOVERED_TOOL_4816'
const finalMarker = 'PRAXIS_RECOVERY_FINAL_7253'
const probeRoot = await mkdtemp(join(tmpdir(), 'praxis-recovery-compat-'))

async function expectRejected(action, message) {
  try {
    await action()
  } catch (error) {
    if (String(error).includes(message)) return
    throw error
  }
  throw new Error(`Expected rejection containing ${message}`)
}

try {
  const configRoot = join(probeRoot, 'config')
  const workDirectory = join(probeRoot, 'work')
  await mkdir(workDirectory, { recursive: true })
  const cwd = await realpath(workDirectory)
  const claudeVersion = await detectClaudeVersion('Recovery probe')
  const controller = new AbortController()
  const interrupted = new ClaudeSessionService({
    configRoot,
    cwd,
    claudeVersion,
    provider: {
      model: 'praxis/recovery-fixture',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        yield {
          type: 'tool-call',
          call: {
            id: 'call_interrupted_recovery_probe',
            name: 'Bash',
            input: { command: 'original command' },
          },
        }
      },
    },
    tools: {
      definitions: () => [
        { name: 'Bash', description: 'fixture', inputSchema: {} },
      ],
      async prepare(call) {
        return call
      },
      async execute() {
        controller.abort()
        throw new Error('interrupted')
      },
    },
    permissions: { resolve: () => ({ behavior: 'allow' }) },
  })

  try {
    await interrupted.run('Start an interruptible tool.', controller.signal)
    throw new Error('Interrupted turn unexpectedly completed')
  } catch (error) {
    if (!(error instanceof AgentRunCancelledError)) throw error
  }

  const [session] = await interrupted.sessions()
  if (!session) throw new Error('Interrupted session was not discoverable')
  const sessionFile = resolveClaudePaths({
    configDir: configRoot,
    cwd,
    sessionId: session.sessionId,
  }).sessionFile
  const beforeDecline = await readFile(sessionFile, 'utf8')
  const recoveryTools = {
    definitions: () => [
      { name: 'Bash', description: 'fixture', inputSchema: {} },
    ],
    async prepare(call) {
      return { ...call, input: { command: 'prepared recovery command' } }
    },
    async execute(call) {
      if (call.input.command !== 'prepared recovery command') {
        throw new Error('Recovery executed the unprepared tool input')
      }
      return { content: recoveryMarker, isError: false }
    },
  }
  const declined = new ClaudeSessionService({
    configRoot,
    cwd,
    claudeVersion,
    provider: {
      capabilities: { streaming: true, usage: true, tools: true },
      complete() {
        throw new Error('Provider must not run after recovery decline')
      },
    },
    tools: recoveryTools,
    permissions: { resolve: () => ({ behavior: 'ask' }) },
    approveRecovery: () => false,
  })
  await expectRejected(
    () => declined.resume(session.sessionId, 'Continue safely.'),
    'recovery was declined',
  )
  if ((await readFile(sessionFile, 'utf8')) !== beforeDecline) {
    throw new Error('Declined recovery modified the shared transcript')
  }

  let approvals = 0
  const recovered = new ClaudeSessionService({
    configRoot,
    cwd,
    claudeVersion,
    provider: {
      model: 'praxis/recovery-fixture',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        if (
          !request.messages.some(
            (message) =>
              message.role === 'tool' && message.content === recoveryMarker,
          )
        ) {
          throw new Error('Recovered tool result did not reach the provider')
        }
        yield { type: 'text-delta', delta: finalMarker }
      },
    },
    tools: recoveryTools,
    permissions: { resolve: () => ({ behavior: 'ask' }) },
    approveRecovery(call) {
      approvals += 1
      if (call.input.command !== 'prepared recovery command') {
        throw new Error('Recovery approval did not receive prepared input')
      }
      return true
    },
  })
  const result = await recovered.resume(session.sessionId, 'Continue safely.')
  if (approvals !== 1 || result.text !== finalMarker) {
    throw new Error('Approved recovery did not complete exactly once')
  }

  const claude = await runClaudeJson(
    [
      '-p',
      '--resume',
      session.sessionId,
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--output-format',
      'json',
      'Reply with both distinct tokens matching PRAXIS_RECOVER[A-Z0-9_]+ and PRAXIS_RECOVERY_[A-Z0-9_]+ from the prior recovered tool result and final response.',
    ],
    cwd,
    configRoot,
  )
  if (
    claude.type !== 'result' ||
    claude.is_error ||
    !String(claude.result).includes(recoveryMarker) ||
    !String(claude.result).includes(finalMarker)
  ) {
    throw new Error(
      `Claude did not resume recovered context: ${JSON.stringify(claude)}`,
    )
  }

  console.log(
    `Claude ${claudeVersion} crash recovery passed: decline is append-free, prepared input is approved once, tool result persists, and Claude resumes it`,
  )
} finally {
  await rm(probeRoot, { recursive: true })
}
