import type { ModelMessage } from './runtime.js'

export type SystemContextMessage = Extract<ModelMessage, { role: 'system' }>

export type ContextSectionStability = 'static' | 'session' | 'volatile'
export type ContextSectionPlacement = 'system' | 'first-user'
export type ContextCompositionMode =
  'default' | 'custom' | 'bare' | 'agent' | 'subagent'

export interface ContextSection {
  id: string
  content: string
  placement: ContextSectionPlacement
  stability: ContextSectionStability
}

export interface ContextSnapshot {
  sections: readonly ContextSection[]
}

export interface ContextProjection {
  systemMessages: readonly SystemContextMessage[]
  firstUserMessageContext?: string
  stableSystemSectionCount: number
}

export interface TurnContextInputs {
  planMode?: string
  sessionMemory?: string
  briefOutput?: boolean
  structuredOutput?: boolean
}

export interface ContextAssemblyOptions {
  cwd?: string
  lifecycleId?: string
  mode?: ContextCompositionMode
  baseSystemPrompt?: string
  turn?: TurnContextInputs
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
  assemble(options?: ContextAssemblyOptions): Promise<ContextSnapshot>
  invalidate?(options: ContextInvalidationOptions): void
}

function validateContextSections(sections: readonly ContextSection[]): void {
  const identities = new Set<string>()
  let volatileSystemSeen = false
  for (const section of sections) {
    if (!section.id.trim()) throw new Error('Context section id is required')
    if (!section.content.trim()) {
      throw new Error(`Context section ${section.id} content is required`)
    }
    if (identities.has(section.id)) {
      throw new Error(`Duplicate context section ${section.id}`)
    }
    identities.add(section.id)
    if (section.placement === 'system') {
      if (section.stability === 'volatile') volatileSystemSeen = true
      else if (volatileSystemSeen) {
        throw new Error(
          'Non-volatile system sections cannot follow volatile sections',
        )
      }
    }
  }
}

export function createContextSnapshot(
  sections: readonly ContextSection[],
): ContextSnapshot {
  validateContextSections(sections)
  return { sections: sections.map((section) => ({ ...section })) }
}

export function projectContextSnapshot(
  snapshot: ContextSnapshot,
): ContextProjection {
  const sections = snapshot.sections
  validateContextSections(sections)
  const systemSections = sections.filter(
    (section) => section.placement === 'system',
  )
  const firstVolatileSystemIndex = systemSections.findIndex(
    (section) => section.stability === 'volatile',
  )
  const firstUserMessageContext = sections
    .filter((section) => section.placement === 'first-user')
    .map((section) => section.content)
    .join('\n\n')
  return {
    systemMessages: systemSections.map((section) => ({
      role: 'system',
      content: section.content,
    })),
    stableSystemSectionCount:
      firstVolatileSystemIndex < 0
        ? systemSections.length
        : firstVolatileSystemIndex,
    ...(firstUserMessageContext ? { firstUserMessageContext } : {}),
  }
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
