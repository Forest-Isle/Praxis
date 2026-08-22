import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClaudeSessionService } from '../dist/application/session-service.js'
import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import { AgentRunCancelledError } from '../dist/core/runtime.js'
import { ClaudeHookRunner } from '../dist/hooks/claude-hooks.js'
import { detectClaudeVersion, runClaudeJson } from './lib/claude-probe.mjs'

const recoveryMarker = 'amber glass'
const finalMarker = 'cobalt paper'
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
  const terminalizedSource = await readFile(sessionFile, 'utf8')
  await writeFile(
    sessionFile,
    terminalizedSource
      .split('\n')
      .filter(
        (line) =>
          !line.includes('"tool_use_id":"call_interrupted_recovery_probe"'),
      )
      .join('\n'),
  )
  const beforeDecline = await readFile(sessionFile, 'utf8')
  const recoveryHooks = new ClaudeHookRunner({
    cwd,
    settings: [
      {
        path: join(configRoot, 'recovery-hooks.json'),
        scope: 'user',
        value: {
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'command', command: 'session-start' }] },
            ],
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'pre-tool-use' }],
              },
            ],
          },
        },
      },
    ],
    async executeCommand(_command, input) {
      return input.hook_event_name === 'PreToolUse'
        ? {
            stdout: JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                updatedInput: { command: 'hook recovery command' },
                additionalContext: 'RECOVERY_PRE_HOOK_CONTEXT',
              },
            }),
            stderr: '',
            exitCode: 0,
            durationMs: 1,
          }
        : {
            stdout: 'RECOVERY_SESSION_HOOK_CONTEXT\n',
            stderr: '',
            exitCode: 0,
            durationMs: 1,
          }
    },
  })
  const recoveryTools = {
    definitions: () => [
      { name: 'Bash', description: 'fixture', inputSchema: {} },
    ],
    async prepare(call) {
      return {
        ...call,
        input: { command: `prepared:${String(call.input.command)}` },
      }
    },
    async execute(call) {
      if (call.input.command !== 'prepared:hook recovery command') {
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
    hooks: recoveryHooks,
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
    hooks: recoveryHooks,
    approveRecovery(call) {
      approvals += 1
      if (call.input.command !== 'prepared:hook recovery command') {
        throw new Error('Recovery approval did not receive prepared input')
      }
      return true
    },
  })
  const result = await recovered.resume(session.sessionId, 'Continue safely.')
  if (approvals !== 1 || result.text !== finalMarker) {
    throw new Error('Approved recovery did not complete exactly once')
  }
  const recoveredEntries = (await readFile(sessionFile, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((entry) => JSON.parse(entry))
  const sessionStartIndex = recoveredEntries.findIndex(
    (entry) => entry.attachment?.hookEvent === 'SessionStart',
  )
  const preToolUseIndex = recoveredEntries.findIndex(
    (entry) => entry.attachment?.hookEvent === 'PreToolUse',
  )
  const toolResultIndex = recoveredEntries.findIndex(
    (entry) =>
      entry.message?.content?.[0]?.tool_use_id ===
      'call_interrupted_recovery_probe',
  )
  if (
    sessionStartIndex < 0 ||
    preToolUseIndex <= sessionStartIndex ||
    toolResultIndex <= preToolUseIndex
  ) {
    throw new Error('Approved recovery did not persist staged hooks in order')
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
      'The prior recovered tool result and final assistant response each contain a harmless two-word phrase. Reply with both phrases verbatim, separated by a comma.',
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
    `Claude ${claudeVersion} crash recovery passed: hook-producing decline is append-free, approved hooks persist in order, prepared input is approved once, tool result persists, and Claude resumes it`,
  )
} finally {
  await rm(probeRoot, { recursive: true })
}
