import {
  injectFirstUserMessageContext,
  type ContextAssembler,
  type ContextAssemblyOptions,
  projectContextSnapshot,
  type SystemContextMessage,
} from '../core/context.js'
import { assembleContextSnapshot } from '../core/prompt-composer.js'
import type { ModelMessage, ModelToolDefinition } from '../core/runtime.js'
import type { ContextEnvelope } from './context-engine.js'

export interface ContextPreparationProjection {
  readonly generation: number
  readonly envelope: ContextEnvelope
  readonly stableSystemMessageCount: number
}

export interface ContextPreparationSources {
  readonly history: () => readonly ModelMessage[]
  readonly memory: () => readonly ModelMessage[]
  readonly activeTools: () => readonly ModelToolDefinition[]
}

export interface ContextPreparationProjectOptions {
  readonly includeHistory?: boolean
  readonly includeMemory?: boolean
  readonly pendingMessages?: readonly ModelMessage[]
}

export interface ContextHistoryReplacement {
  readonly generation: number
  readonly envelope: ContextEnvelope
  readonly stableSystemMessageCount: number
  commit<T>(
    replace: () => Promise<T>,
  ): Promise<{ generation: number; value: T }>
}

export class StaleContextGenerationError extends Error {
  readonly expectedGeneration: number
  readonly actualGeneration: number

  constructor(expectedGeneration: number, actualGeneration: number) {
    super(
      `Stale context generation: expected ${expectedGeneration}, actual ${actualGeneration}; prepare a new history replacement`,
    )
    this.name = 'StaleContextGenerationError'
    this.expectedGeneration = expectedGeneration
    this.actualGeneration = actualGeneration
  }
}

export interface ContextPreparationOptions {
  readonly assembler?: ContextAssembler
  readonly sources: ContextPreparationSources
  readonly agentMentions?: () => {
    readonly prompt: string
    readonly messages: readonly string[]
  }
  readonly initialGeneration?: number
}

type PreparedContext = {
  readonly stableSystemMessages: readonly SystemContextMessage[]
  readonly volatileSystemMessages: readonly SystemContextMessage[]
  readonly firstUserMessageContext?: string
  readonly stableSystemMessageCount: number
}

function validateGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new TypeError('Context generation must be a positive safe integer')
  }
}

function cloneTools(
  tools: readonly ModelToolDefinition[],
): readonly ModelToolDefinition[] {
  return tools.map((tool) => ({ ...tool }))
}

/** Owns provider-visible context projection and guarded history replacement. */
export class ContextPreparation {
  private readonly assembler: ContextAssembler | undefined
  private readonly sources: ContextPreparationSources
  private readonly agentMentions:
    (() => { prompt: string; messages: readonly string[] }) | undefined
  private generation: number
  private prepared: PreparedContext | undefined
  private replacementQueue: Promise<void> = Promise.resolve()

  constructor(options: ContextPreparationOptions) {
    this.assembler = options.assembler
    this.sources = options.sources
    this.agentMentions = options.agentMentions
    this.generation = options.initialGeneration ?? 1
    validateGeneration(this.generation)
  }

  async refresh(options: ContextAssemblyOptions = {}): Promise<void> {
    const snapshot = await assembleContextSnapshot(this.assembler, options)
    const projection = projectContextSnapshot(snapshot)
    const stableCount = projection.stableSystemSectionCount
    const prepared: PreparedContext = {
      stableSystemMessages: projection.systemMessages.slice(0, stableCount),
      volatileSystemMessages: projection.systemMessages.slice(stableCount),
      ...(projection.firstUserMessageContext === undefined
        ? {}
        : { firstUserMessageContext: projection.firstUserMessageContext }),
      stableSystemMessageCount: stableCount,
    }
    this.prepared = prepared
  }

  project(
    options: ContextPreparationProjectOptions = {},
  ): ContextPreparationProjection {
    return this.projectWithMessages(
      (options.includeHistory ?? true) ? this.sources.history() : [],
      (options.includeMemory ?? true) ? this.sources.memory() : [],
      options.pendingMessages ?? [],
    )
  }

  proposeHistoryReplacement(input: {
    readonly historyMessages: readonly ModelMessage[]
    readonly pendingMessages?: readonly ModelMessage[]
  }): ContextHistoryReplacement {
    const baseGeneration = this.generation
    if (baseGeneration === Number.MAX_SAFE_INTEGER) {
      throw new RangeError(
        'Context generation cannot exceed Number.MAX_SAFE_INTEGER',
      )
    }
    const generation = baseGeneration + 1
    const projection = this.projectWithMessages(
      input.historyMessages,
      [],
      input.pendingMessages ?? [],
    )
    let committed = false
    return {
      generation,
      envelope: projection.envelope,
      stableSystemMessageCount: projection.stableSystemMessageCount,
      commit: async <T>(replace: () => Promise<T>) => {
        const operation = this.replacementQueue.then(async () => {
          if (this.generation !== baseGeneration) {
            throw new StaleContextGenerationError(
              baseGeneration,
              this.generation,
            )
          }
          if (committed) {
            throw new StaleContextGenerationError(
              baseGeneration,
              this.generation,
            )
          }
          const value = await replace()
          this.generation = generation
          committed = true
          return { generation, value }
        })
        this.replacementQueue = operation.then(
          () => undefined,
          () => undefined,
        )
        return operation
      },
    }
  }

  private projectWithMessages(
    historyMessages: readonly ModelMessage[],
    memoryMessages: readonly ModelMessage[],
    pendingMessages: readonly ModelMessage[],
  ): ContextPreparationProjection {
    const prepared = this.prepared
    if (!prepared) {
      throw new Error('ContextPreparation must be refreshed before projecting')
    }
    const history = [...historyMessages]
    const memory = [...memoryMessages]
    const pending = [...pendingMessages]
    const decoratedHistory = this.decorate([...history, ...memory, ...pending])
    const messages = [
      ...prepared.stableSystemMessages,
      ...prepared.volatileSystemMessages,
      ...decoratedHistory,
    ]
    return {
      generation: this.generation,
      envelope: {
        messages,
        tools: cloneTools(this.sources.activeTools()),
      },
      stableSystemMessageCount: prepared.stableSystemMessageCount,
    }
  }

  private decorate(messages: readonly ModelMessage[]): ModelMessage[] {
    const prepared = this.prepared
    if (!prepared) {
      throw new Error('ContextPreparation must be refreshed before projecting')
    }
    const withFirstUserContext = injectFirstUserMessageContext(
      messages,
      prepared.firstUserMessageContext,
    )
    const mentionInput = this.agentMentions?.()
    if (!mentionInput || mentionInput.messages.length === 0)
      return withFirstUserContext
    let insertionIndex = withFirstUserContext.length
    let foundPrompt = false
    for (let index = withFirstUserContext.length - 1; index >= 0; index -= 1) {
      const message = withFirstUserContext[index]
      if (
        message?.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.endsWith(mentionInput.prompt)
      ) {
        insertionIndex = index
        foundPrompt = true
        break
      }
    }
    if (!foundPrompt) return withFirstUserContext
    return [
      ...withFirstUserContext.slice(0, insertionIndex),
      ...mentionInput.messages.map((content) => ({
        role: 'user' as const,
        content,
      })),
      ...withFirstUserContext.slice(insertionIndex),
    ]
  }
}
