import { mkdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import type { ClaudeTranscriptEntry } from '../compatibility/claude/schema.js'
import type {
  ModelToolCall,
  ModelToolDefinition,
  PermissionDecision,
  PermissionResolutionContext,
  PermissionResolver,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from '../core/runtime.js'
import type { ClaudePermissionMode } from '../permissions/claude-permission-resolver.js'

export interface ClaudeQuestionOption {
  label: string
  description: string
  preview?: string
}

export interface ClaudeQuestion {
  question: string
  header: string
  options: readonly ClaudeQuestionOption[]
  multiSelect: boolean
}

export interface ClaudeQuestionResult {
  answers: Readonly<Record<string, string>>
  annotations?: Readonly<Record<string, { preview?: string; notes?: string }>>
}

export interface ClaudePlanApprovalRequest {
  action: 'exit'
  planPath: string
  plan?: string
  previousMode: ClaudePermissionMode
}

export type ClaudePlanApprovalResult =
  | {
      behavior: 'allow'
      permissionMode: ClaudePermissionMode
      feedback?: string
    }
  | { behavior: 'deny'; feedback?: string }

export interface ClaudeInteractiveToolCallbacks {
  askUser(
    questions: readonly ClaudeQuestion[],
    signal?: AbortSignal,
  ): Promise<ClaudeQuestionResult | null>
  approvePlan(
    request: ClaudePlanApprovalRequest,
    signal?: AbortSignal,
  ): Promise<ClaudePlanApprovalResult>
}

export interface ClaudeInteractiveToolSettings {
  useAutoModeDuringPlan: boolean
}

interface SessionPlanState {
  mode: ClaudePermissionMode
  previousMode: ClaudePermissionMode
  planPath: string
}

const ASK_USER_QUESTION: ModelToolDefinition = {
  name: 'AskUserQuestion',
  description:
    "Use this tool only when you are blocked on a decision that is genuinely the user's to make: one you cannot resolve from the request, the code, or sensible defaults. Users can always provide custom text. Use multiSelect for non-exclusive choices. In plan mode, use this tool to clarify requirements before ExitPlanMode; do not use it to request plan approval.",
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      questions: {
        description: 'Questions to ask the user (1-4 questions)',
        minItems: 1,
        maxItems: 4,
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            header: { type: 'string' },
            options: {
              minItems: 2,
              maxItems: 4,
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                  preview: { type: 'string' },
                },
                required: ['label', 'description'],
                additionalProperties: false,
              },
            },
            multiSelect: { default: false, type: 'boolean' },
          },
          required: ['question', 'header', 'options', 'multiSelect'],
          additionalProperties: false,
        },
      },
      answers: {
        type: 'object',
        propertyNames: { type: 'string' },
        additionalProperties: { type: 'string' },
      },
      annotations: {
        type: 'object',
        propertyNames: { type: 'string' },
        additionalProperties: {
          type: 'object',
          properties: {
            preview: { type: 'string' },
            notes: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      metadata: {
        type: 'object',
        properties: { source: { type: 'string' } },
        additionalProperties: false,
      },
    },
    required: ['questions'],
    additionalProperties: false,
  },
}

const ENTER_PLAN_MODE: ModelToolDefinition = {
  name: 'EnterPlanMode',
  description:
    'Use this tool before a non-trivial implementation task to enter a read-only planning phase. Explore the codebase, clarify decisions with AskUserQuestion, write the final plan to the plan file named in the tool result, then call ExitPlanMode for approval.',
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
}

const EXIT_PLAN_MODE: ModelToolDefinition = {
  name: 'ExitPlanMode',
  description:
    'Use this tool after the final implementation plan has been written to the plan file. It displays that file and asks the user to approve leaving plan mode. Use AskUserQuestion first if any design decision remains unresolved.',
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      allowedPrompts: {
        description: 'Deprecated: no longer used.',
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string', enum: ['Bash'] },
            prompt: { type: 'string' },
          },
          required: ['tool', 'prompt'],
          additionalProperties: false,
        },
      },
    },
    additionalProperties: {},
  },
}

const INTERACTIVE_DEFINITIONS = [
  ASK_USER_QUESTION,
  ENTER_PLAN_MODE,
  EXIT_PLAN_MODE,
] as const
const INTERACTIVE_NAMES = new Set(
  INTERACTIVE_DEFINITIONS.map(({ name }) => name),
)

function object(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label} must be an object`)
  }
  return input as Record<string, unknown>
}

function strictKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed)
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) throw new Error(`Unknown ${label} field ${key}`)
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function questionsFrom(input: Record<string, unknown>): ClaudeQuestion[] {
  strictKeys(
    input,
    ['questions', 'answers', 'annotations', 'metadata'],
    'input',
  )
  if (!Array.isArray(input.questions)) {
    throw new Error('questions must be an array')
  }
  if (input.questions.length < 1 || input.questions.length > 4) {
    throw new Error('questions must contain between 1 and 4 items')
  }
  return input.questions.map((rawQuestion, questionIndex) => {
    const question = object(rawQuestion, `questions[${questionIndex}]`)
    strictKeys(
      question,
      ['question', 'header', 'options', 'multiSelect'],
      `questions[${questionIndex}]`,
    )
    if (!Array.isArray(question.options)) {
      throw new Error(`questions[${questionIndex}].options must be an array`)
    }
    if (question.options.length < 2 || question.options.length > 4) {
      throw new Error(
        `questions[${questionIndex}].options must contain between 2 and 4 items`,
      )
    }
    if (typeof question.multiSelect !== 'boolean') {
      throw new Error(`questions[${questionIndex}].multiSelect must be boolean`)
    }
    return {
      question: nonEmptyString(
        question.question,
        `questions[${questionIndex}].question`,
      ),
      header: nonEmptyString(
        question.header,
        `questions[${questionIndex}].header`,
      ),
      options: question.options.map((rawOption, optionIndex) => {
        const option = object(
          rawOption,
          `questions[${questionIndex}].options[${optionIndex}]`,
        )
        strictKeys(
          option,
          ['label', 'description', 'preview'],
          `questions[${questionIndex}].options[${optionIndex}]`,
        )
        return {
          label: nonEmptyString(
            option.label,
            `questions[${questionIndex}].options[${optionIndex}].label`,
          ),
          description: nonEmptyString(
            option.description,
            `questions[${questionIndex}].options[${optionIndex}].description`,
          ),
          ...(option.preview === undefined
            ? {}
            : {
                preview: nonEmptyString(
                  option.preview,
                  `questions[${questionIndex}].options[${optionIndex}].preview`,
                ),
              }),
        }
      }),
      multiSelect: question.multiSelect,
    }
  })
}

class ClaudeInteractiveToolRegistry implements ToolRegistry {
  constructor(
    private readonly base: ToolRegistry,
    private readonly manager: ClaudeInteractiveToolManager,
    private readonly sessionId: string,
  ) {}

  definitions(): readonly ModelToolDefinition[] {
    return [
      ...this.base.definitions(),
      ...INTERACTIVE_DEFINITIONS.filter(({ name }) =>
        this.manager.enabledNames.has(name),
      ),
    ]
  }

  async prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    return this.manager.enabledNames.has(call.name)
      ? call
      : this.base.prepare(call, context)
  }

  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (!this.manager.enabledNames.has(call.name)) {
      return this.base.execute(call, context)
    }
    try {
      if (call.name === 'AskUserQuestion') {
        const questions = questionsFrom(call.input)
        const result = await this.manager.callbacks.askUser(
          questions,
          context.signal,
        )
        return result
          ? { content: JSON.stringify(result), isError: false }
          : { content: 'User cancelled the question.', isError: true }
      }
      if (call.name === 'EnterPlanMode') {
        strictKeys(call.input, [], 'EnterPlanMode input')
        return this.manager.enter(this.sessionId, call)
      }
      strictKeys(call.input, ['allowedPrompts'], 'ExitPlanMode input')
      return this.manager.exit(this.sessionId, call, context.signal)
    } catch (error) {
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  }
}

export class ClaudeInteractiveToolManager {
  readonly callbacks: ClaudeInteractiveToolCallbacks
  readonly enabledNames: ReadonlySet<string>
  private readonly states = new Map<string, SessionPlanState>()
  private readonly transitions = new Map<string, ClaudePermissionMode>()
  private readonly resolvers = new Map<
    ClaudePermissionMode,
    PermissionResolver
  >()

  constructor(
    private readonly options: {
      configRoot: string
      initialMode: ClaudePermissionMode
      enabledTools: readonly string[]
      callbacks: ClaudeInteractiveToolCallbacks
      permissionResolverForMode(mode: ClaudePermissionMode): PermissionResolver
      settings?: ClaudeInteractiveToolSettings
    },
  ) {
    this.callbacks = options.callbacks
    this.enabledNames = new Set(
      options.enabledTools.filter((name) => INTERACTIVE_NAMES.has(name)),
    )
  }

  registry(base: ToolRegistry, sessionId: string): ToolRegistry {
    this.state(sessionId)
    return new ClaudeInteractiveToolRegistry(base, this, sessionId)
  }

  restore(sessionId: string, entries: readonly ClaudeTranscriptEntry[]): void {
    const modes = entries
      .filter((entry) => entry.type === 'permission-mode')
      .map((entry) => entry.permissionMode)
      .filter((mode): mode is ClaudePermissionMode =>
        [
          'acceptEdits',
          'auto',
          'bypassPermissions',
          'default',
          'dontAsk',
          'manual',
          'plan',
        ].includes(String(mode)),
      )
    const mode = modes.at(-1) ?? this.options.initialMode
    const fallbackMode =
      this.options.initialMode === 'plan' ? 'default' : this.options.initialMode
    const previousMode =
      mode === 'plan'
        ? (modes.slice(0, -1).findLast((candidate) => candidate !== 'plan') ??
          fallbackMode)
        : mode
    this.states.set(sessionId, {
      mode,
      previousMode,
      planPath: this.planPath(sessionId),
    })
  }

  async setMode(sessionId: string, mode: ClaudePermissionMode): Promise<void> {
    const state = this.state(sessionId)
    if (state.mode === mode) return
    if (mode === 'plan') {
      await mkdir(resolve(this.options.configRoot, 'plans'), {
        recursive: true,
      })
      state.previousMode = state.mode
    }
    state.mode = mode
  }

  permissions(sessionId: string): PermissionResolver {
    return {
      resolve: (call, context) => this.resolve(sessionId, call, context),
    }
  }

  mode(sessionId: string): ClaudePermissionMode {
    return this.state(sessionId).mode
  }

  contextMessage(sessionId: string): string | null {
    const state = this.state(sessionId)
    if (state.mode !== 'plan') return null
    return `# Plan mode

You are in a read-only planning phase. Explore and design the implementation without changing project files. The only file you may create or edit is the plan file:

${state.planPath}

Use AskUserQuestion for decisions that genuinely require the user. Write a complete, actionable plan to that file, then call ExitPlanMode to request approval.`
  }

  async isPlanFile(sessionId: string, requestedPath: string): Promise<boolean> {
    const state = this.state(sessionId)
    return (
      state.mode === 'plan' && this.isPlanFileForState(state, requestedPath)
    )
  }

  consumeTransition(callId: string): ClaudePermissionMode | undefined {
    const mode = this.transitions.get(callId)
    this.transitions.delete(callId)
    return mode
  }

  private state(sessionId: string): SessionPlanState {
    let state = this.states.get(sessionId)
    if (!state) {
      state = {
        mode: this.options.initialMode,
        previousMode:
          this.options.initialMode === 'plan'
            ? 'default'
            : this.options.initialMode,
        planPath: this.planPath(sessionId),
      }
      this.states.set(sessionId, state)
    }
    return state
  }

  private planPath(sessionId: string): string {
    return resolve(this.options.configRoot, 'plans', `praxis-${sessionId}.md`)
  }

  private resolver(mode: ClaudePermissionMode): PermissionResolver {
    let resolver = this.resolvers.get(mode)
    if (!resolver) {
      resolver = this.options.permissionResolverForMode(mode)
      this.resolvers.set(mode, resolver)
    }
    return resolver
  }

  private resolve(
    sessionId: string,
    call: ModelToolCall,
    context?: PermissionResolutionContext,
  ): PermissionDecision | Promise<PermissionDecision> {
    const state = this.state(sessionId)
    if (this.enabledNames.has(call.name)) return { behavior: 'allow' }
    if (
      state.mode === 'plan' &&
      (call.name === 'Write' || call.name === 'Edit') &&
      typeof call.input.file_path === 'string'
    ) {
      return this.resolvePlanFile(state, call, context)
    }
    return this.resolver(this.planPermissionMode(sessionId)).resolve(
      call,
      context,
    )
  }

  private async resolvePlanFile(
    state: SessionPlanState,
    call: ModelToolCall,
    context?: PermissionResolutionContext,
  ): Promise<PermissionDecision> {
    const requestedPath = String(call.input.file_path)
    if (await this.isPlanFileForState(state, requestedPath)) {
      return { behavior: 'allow' }
    }
    return this.resolver(state.mode).resolve(call, context)
  }

  private async isPlanFileForState(
    state: SessionPlanState,
    requestedPath: string,
  ): Promise<boolean> {
    const canonical = async (path: string) =>
      join(await realpath(dirname(path)), basename(path))
    try {
      return (
        (await canonical(requestedPath)) === (await canonical(state.planPath))
      )
    } catch {
      return resolve(requestedPath) === state.planPath
    }
  }

  async enter(
    sessionId: string,
    call: ModelToolCall,
  ): Promise<ToolExecutionResult> {
    const state = this.state(sessionId)
    if (state.mode === 'plan') {
      return {
        content: `Already in plan mode. Write the plan to ${state.planPath}.`,
        isError: false,
      }
    }
    await mkdir(resolve(this.options.configRoot, 'plans'), { recursive: true })
    state.previousMode = state.mode
    state.mode = 'plan'
    this.transitions.set(call.id, 'plan')
    return {
      content: `Entered plan mode. Explore without modifying project files, write the final plan to ${state.planPath}, then call ExitPlanMode.`,
      isError: false,
    }
  }

  planPermissionMode(sessionId: string): ClaudePermissionMode {
    const state = this.state(sessionId)
    if (state.mode !== 'plan') return state.mode
    if (this.options.settings?.useAutoModeDuringPlan === false) return 'plan'
    return state.previousMode === 'bypassPermissions' ? 'plan' : 'auto'
  }

  async exit(
    sessionId: string,
    call: ModelToolCall,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const state = this.state(sessionId)
    if (state.mode !== 'plan') {
      return {
        content: 'ExitPlanMode can only be used in plan mode.',
        isError: true,
      }
    }
    let plan: string | undefined
    try {
      plan = await readFile(state.planPath, 'utf8')
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        if (error.code === 'ENOENT') {
          plan = undefined
        } else {
          throw error
        }
      } else throw error
    }
    const approval = await this.callbacks.approvePlan(
      {
        action: 'exit',
        planPath: state.planPath,
        previousMode: state.previousMode,
        ...(plan === undefined ? {} : { plan }),
      },
      signal,
    )
    if (approval.behavior === 'deny') {
      return {
        content: approval.feedback
          ? `User declined the plan with feedback: ${approval.feedback}\n\nRemain in plan mode and revise it.`
          : 'User declined the plan. Remain in plan mode and revise it.',
        isError: true,
      }
    }
    state.mode = approval.permissionMode
    this.transitions.set(call.id, state.mode)
    return {
      content: plan?.trim()
        ? `User approved the plan. Plan mode ended; implementation may begin.\n\nPlan file: ${state.planPath}\n\n## Approved Plan:\n${plan}`
        : 'User approved exiting plan mode. Plan mode ended; implementation may begin.',
      isError: false,
      ...(approval.feedback
        ? { followUpUserMessages: [approval.feedback] }
        : {}),
    }
  }
}
