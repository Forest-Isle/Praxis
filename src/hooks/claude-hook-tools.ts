import type {
  ModelToolCall,
  PermissionDecision,
  PermissionResolver,
  PermissionResolutionContext,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from '../core/runtime.js'
import { permissionDecisionSource } from '../core/runtime.js'
import type { ClaudeHookOutcome, ClaudeHookRunner } from './claude-hooks.js'

export interface ClaudeHookSessionInput {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode: string
}

export interface ClaudeHookToolCoordinatorOptions {
  tools: ToolRegistry
  permissions: PermissionResolver
  hooks: ClaudeHookRunner
  session: ClaudeHookSessionInput
  recordOutcome(
    outcome: ClaudeHookOutcome,
    deferUntilApproval?: boolean,
  ): Promise<void>
  warn?(message: string): void
  deferPreToolUseOutcome?(call: ModelToolCall): boolean
}

interface PreparedHookCall {
  hookInput: Record<string, unknown>
  permissionDecision?: PermissionDecision
  signal?: AbortSignal
}

export class ClaudeHookToolCoordinator
  implements ToolRegistry, PermissionResolver
{
  private readonly prepared = new Map<string, PreparedHookCall>()

  constructor(private readonly options: ClaudeHookToolCoordinatorOptions) {}

  definitions() {
    return this.options.tools.definitions()
  }

  schedulingPolicy() {
    return {
      concurrency: 'exclusive' as const,
      startAfterAssistant: true,
    }
  }

  async prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    const outcome = await this.options.hooks.run(
      {
        ...this.options.session,
        hook_event_name: 'PreToolUse',
        tool_name: call.name,
        tool_input: call.input,
        tool_use_id: call.id,
      },
      call.name,
      context.signal,
    )
    if (this.options.deferPreToolUseOutcome?.(call)) {
      await this.options.recordOutcome(outcome, true)
    } else {
      await this.options.recordOutcome(outcome)
    }
    if (outcome.blockedReason) {
      throw new Error(
        `PreToolUse:${call.name} hook error: ${outcome.blockedReason}`,
      )
    }
    const hookInput = outcome.updatedInput ?? call.input
    this.prepared.set(call.id, {
      hookInput,
      ...(context.signal ? { signal: context.signal } : {}),
      ...(outcome.permissionDecision
        ? {
            permissionDecision:
              outcome.permissionDecision === 'deny'
                ? {
                    behavior: 'deny',
                    reason:
                      outcome.permissionDecisionReason ??
                      `PreToolUse:${call.name} hook denied tool`,
                  }
                : outcome.permissionDecision === 'ask'
                  ? {
                      behavior: 'ask',
                      ...(outcome.permissionDecisionReason
                        ? { reason: outcome.permissionDecisionReason }
                        : {}),
                    }
                  : { behavior: 'allow' },
          }
        : {}),
    })
    return this.options.tools.prepare({ ...call, input: hookInput }, context)
  }

  async resolve(
    call: ModelToolCall,
    context?: PermissionResolutionContext,
  ): Promise<PermissionDecision> {
    const prepared = this.prepared.get(call.id)
    if (prepared?.permissionDecision) {
      return this.withPermissionDeniedHook(
        call,
        prepared.permissionDecision,
        prepared.signal,
      )
    }
    const decision = await this.options.permissions.resolve(call, context)
    if (decision.behavior !== 'ask') {
      return this.withPermissionDeniedHook(call, decision, prepared?.signal)
    }

    const outcome = await this.options.hooks.run(
      {
        ...this.options.session,
        hook_event_name: 'PermissionRequest',
        tool_name: call.name,
        tool_input: prepared?.hookInput ?? call.input,
        tool_use_id: call.id,
        permission_suggestions: decision.suggestions ?? [],
      },
      call.name,
      prepared?.signal,
    )
    await this.options.recordOutcome(outcome)
    if (outcome.blockedReason || outcome.permissionDecision === 'deny') {
      return this.withPermissionDeniedHook(
        call,
        {
          behavior: 'deny',
          reason:
            outcome.blockedReason ??
            outcome.permissionDecisionReason ??
            `PermissionRequest:${call.name} hook denied tool`,
        },
        prepared?.signal,
      )
    }
    if (outcome.permissionDecision === 'allow') return { behavior: 'allow' }
    return decision
  }

  private async withPermissionDeniedHook(
    call: ModelToolCall,
    decision: PermissionDecision,
    signal?: AbortSignal,
  ): Promise<PermissionDecision> {
    const decisionSource = permissionDecisionSource(decision)
    if (decision.behavior !== 'deny' || decisionSource !== 'auto-classifier') {
      return decision
    }
    const prepared = this.prepared.get(call.id)
    try {
      const outcome = await this.options.hooks.run(
        {
          ...this.options.session,
          hook_event_name: 'PermissionDenied',
          tool_name: call.name,
          tool_input: prepared?.hookInput ?? call.input,
          tool_use_id: call.id,
          reason: decision.reason,
        },
        call.name,
        signal,
      )
      await this.options.recordOutcome(outcome)
      if (outcome.retry) {
        return {
          ...decision,
          followUpUserMessages: [
            ...(decision.followUpUserMessages ?? []),
            'The PermissionDenied hook indicated this command is now approved. You may retry it if you would like.',
          ],
          source: decisionSource,
        }
      }
    } catch (error) {
      if (
        signal?.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        throw error
      }
      this.options.warn?.(
        `PermissionDenied:${call.name} hook failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    return decision
  }

  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const prepared = this.prepared.get(call.id)
    try {
      let result: ToolExecutionResult
      try {
        result = await this.options.tools.execute(call, {
          ...context,
          ...(prepared?.permissionDecision?.behavior === 'allow'
            ? { preToolUseAllowed: true }
            : {}),
        })
      } catch (error) {
        result = {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        }
      }
      const event = result.isError ? 'PostToolUseFailure' : 'PostToolUse'
      const outcome = await this.options.hooks.run(
        {
          ...this.options.session,
          hook_event_name: event,
          tool_name: call.name,
          tool_input: prepared?.hookInput ?? call.input,
          ...(result.isError
            ? { error: result.content, is_interrupt: false }
            : {
                tool_response: {
                  stdout: result.processOutput?.stdout ?? result.content,
                  stderr: result.processOutput?.stderr ?? '',
                  interrupted: false,
                  isImage: false,
                  noOutputExpected: false,
                },
              }),
          tool_use_id: call.id,
        },
        call.name,
        context.signal,
      )
      await this.options.recordOutcome(outcome)
      const followUpUserMessages = [
        ...(result.followUpUserMessages ?? []),
        ...(outcome.blockedReason
          ? [`${event}:${call.name} hook error: ${outcome.blockedReason}`]
          : []),
      ]
      return {
        ...result,
        ...(followUpUserMessages.length > 0 ? { followUpUserMessages } : {}),
      }
    } finally {
      this.prepared.delete(call.id)
    }
  }
}
