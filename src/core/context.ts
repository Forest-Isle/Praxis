import type { ModelMessage } from './runtime.js'
import type { PromptCompositionMode, PromptSection } from './prompt-composer.js'

export type SystemContextMessage = Extract<ModelMessage, { role: 'system' }>

export interface AssembledContext {
  systemMessages: readonly SystemContextMessage[]
  firstUserMessageContext?: string
  promptSections?: readonly PromptSection[]
  stableSystemSectionCount?: number
}

export interface ContextAssemblyOptions {
  cwd?: string
  lifecycleId?: string
  mode?: PromptCompositionMode
  baseSystemPrompt?: string
  additionalSections?: readonly PromptSection[]
}

export type ContextInvalidationReason =
  | 'clear'
  | 'compact'
  | 'fork'
  | 'resource-reload'
  | 'restore'
  | 'tool-pool'
  | 'cwd'
  | 'worktree'

export interface ContextInvalidationOptions {
  lifecycleId?: string
  reason: ContextInvalidationReason
}

export interface ContextAssembler {
  assemble(options?: ContextAssemblyOptions): Promise<AssembledContext>
  invalidate?(options: ContextInvalidationOptions): void
}

export function injectFirstUserMessageContext(
  messages: readonly ModelMessage[],
  context: string | undefined,
): ModelMessage[] {
  if (context === undefined) return [...messages]
  let injected = false
  const result = messages.map((message) => {
    if (injected || message.role !== 'user') return message
    injected = true
    return { ...message, content: `${context}\n\n${message.content}` }
  })
  return injected ? result : [...result, { role: 'user', content: context }]
}
