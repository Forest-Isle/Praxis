import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  ModelProvider,
  PermissionResolver,
  RuntimeEventSink,
} from '../core/runtime.js'
import type { ContextAssembler } from '../core/context.js'
import type { ClaudeExtensionCatalog } from '../extensions/claude-extensions.js'
import type { ClaudeHookRunner } from '../hooks/claude-hooks.js'
import type { ClaudeMcpRuntime } from '../mcp/claude-mcp-tools.js'
import { resolveProjectIdentity } from '../platform/project-identity.js'
import { sanitizeProjectPath } from '../platform/project-path-key.js'
import {
  ClaudeSubagentExecutor,
  type AgentPermissionMode,
} from './subagent-service.js'
import type { TeamAgentRuntime } from './team-manager.js'
import { teamMailboxMessageId } from './team-mailbox.js'

export interface ClaudeTeamAgentRuntimeOptions {
  readonly nativeRoot: string
  readonly configRoot: string
  readonly claudeVersion: string
  readonly provider: ModelProvider
  readonly extensions?: ClaudeExtensionCatalog
  readonly mcp?: ClaudeMcpRuntime
  readonly hooks?: ClaudeHookRunner
  readonly contextAssembler?: ContextAssembler
  readonly providerForModel?: (model: string) => ModelProvider
  readonly permissionResolverForMode?: (
    mode: AgentPermissionMode,
  ) => PermissionResolver
  readonly eventSink?: RuntimeEventSink
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function uuidFromHex(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function executionIdentity(
  projectIdentity: string,
  teamId: string,
  taskId: string,
  generation: number,
): {
  sessionId: string
  promptId: string
  runId: string
  agentId: string
  taskDirectory: string
} {
  const value = `${projectIdentity}\0${teamId}\0${taskId}\0${generation}`
  const hash = digest(value)
  return {
    sessionId: uuidFromHex(hash),
    promptId: uuidFromHex(digest(`${value}\0prompt`)),
    runId: `wf_${hash.slice(0, 8)}${hash.slice(8, 14)}-${hash.slice(14, 17)}`,
    agentId: `a${hash.slice(0, 16)}`,
    taskDirectory: `${sanitizeProjectPath(taskId)}-${hash.slice(16, 28)}/generation-${generation}`,
  }
}

function taskPrompt(input: Parameters<TeamAgentRuntime['run']>[0]): string {
  return [
    `Assigned task ID: ${input.task.id}`,
    `Assigned Team task: ${input.task.description}`,
    `Team member: ${input.member.name}`,
    `Agent type: ${input.member.agentType}`,
    `Access: ${input.member.access}`,
    `Assigned cwd: ${input.cwd}`,
    `Assigned branch: ${input.branch ?? '(shared invocation checkout)'}`,
    `Claimed files: ${input.task.claims.files.join(', ') || '(none)'}`,
    `Claimed public contracts: ${input.task.claims.publicContracts.join(', ') || '(none)'}`,
    `Claimed generated artifacts: ${input.task.claims.generatedArtifacts.join(', ') || '(none)'}`,
    `Claimed migrations: ${input.task.claims.migrations.join(', ') || '(none)'}`,
    `Claimed merge targets: ${input.task.claims.mergeTargets.join(', ') || '(none)'}`,
    'Use only the tools provided for this Team member and work only in the assigned cwd.',
  ].join('\n')
}

export class ClaudeTeamAgentRuntime implements TeamAgentRuntime {
  constructor(private readonly options: ClaudeTeamAgentRuntimeOptions) {}

  async run(
    input: Parameters<TeamAgentRuntime['run']>[0],
  ): Promise<'completed' | 'failed' | 'orphaned'> {
    const projectIdentity = await resolveProjectIdentity(input.cwd)
    const identity = executionIdentity(
      projectIdentity,
      input.teamId,
      input.task.id,
      input.generation,
    )
    const transcriptDirectory = join(
      this.options.nativeRoot,
      'state',
      'team-executions',
      sanitizeProjectPath(projectIdentity),
      `team-${digest(input.teamId).slice(0, 16)}`,
      identity.taskDirectory,
    )
    await mkdir(transcriptDirectory, { recursive: true })
    const executor = new ClaudeSubagentExecutor({
      configRoot: this.options.configRoot,
      dataPlane: 'native',
      cwd: input.cwd,
      cwdProvider: () => input.cwd,
      claudeVersion: this.options.claudeVersion,
      provider: this.options.provider,
      persistence: 'disk',
      baseTools: input.tools,
      permissions: input.permissions,
      ...(this.options.extensions
        ? { extensions: this.options.extensions }
        : {}),
      ...(this.options.mcp ? { mcp: this.options.mcp } : {}),
      ...(this.options.hooks ? { hooks: this.options.hooks } : {}),
      ...(this.options.contextAssembler
        ? { contextAssembler: this.options.contextAssembler }
        : {}),
      ...(this.options.providerForModel
        ? { providerForModel: this.options.providerForModel }
        : {}),
      ...(this.options.permissionResolverForMode
        ? {
            permissionResolverForMode: this.options.permissionResolverForMode,
          }
        : {}),
      ...(this.options.eventSink ? { eventSink: this.options.eventSink } : {}),
      sendOwnedBackgroundAgent: async (
        _sessionId: string,
        _agentId: string,
        message: string,
        summary: string | undefined,
        toolUseId: string,
      ) => {
        const recipient = _agentId
        const to = recipient === 'broadcast' ? 'broadcast' : recipient
        const endpoint = input.mailbox
        await endpoint.send({
          messageId: teamMailboxMessageId(
            input.teamId,
            input.member.name,
            toolUseId,
          ),
          to,
          payload: {
            kind: 'text',
            text: message,
            ...(summary === undefined ? {} : { summary }),
          },
        })
        return 'Message sent successfully.'
      },
      durableFollowUpSource: () => input.mailbox.project(),
    })
    let failure: unknown
    try {
      await executor.runWorkflowAgent({
        sessionId: identity.sessionId,
        promptId: identity.promptId,
        runId: identity.runId,
        agentId: identity.agentId,
        transcriptDirectory,
        prompt: taskPrompt(input),
        agentType: input.member.agentType,
        signal: input.signal,
      })
    } catch (error) {
      failure = error
    }
    let closeFailure: unknown
    try {
      await executor.close()
    } catch (error) {
      closeFailure = error
    }
    if (failure !== undefined && closeFailure !== undefined) {
      throw new AggregateError(
        [failure, closeFailure],
        'Team agent execution and cleanup failed',
        { cause: failure },
      )
    }
    if (failure !== undefined) throw failure
    if (closeFailure !== undefined) throw closeFailure
    return 'completed'
  }
}
