import type { SystemContextMessage } from './context.js'

export type PromptSectionStability = 'static' | 'session' | 'volatile'
export type PromptSectionPlacement = 'system' | 'first-user'
export type PromptCompositionMode =
  'default' | 'custom' | 'bare' | 'agent' | 'subagent'

export interface PromptSection {
  id: string
  content: string
  stability: PromptSectionStability
  placement: PromptSectionPlacement
}

export interface PromptComposition {
  sections: readonly PromptSection[]
  systemMessages: readonly SystemContextMessage[]
  firstUserMessageContext?: string
  stableSystemSectionCount: number
}

export interface PromptCompositionOptions {
  mode: PromptCompositionMode
  baseSystemPrompt?: string
  appendSystemPrompt?: string
  sessionSections?: readonly PromptSection[]
  tailSections?: readonly PromptSection[]
}

const PRODUCT_POLICY = `# Praxis

You are Praxis, a local CLI coding agent. Work until the user's request is genuinely handled or a concrete blocker requires their input.

- Inspect relevant context before acting and use available tools deliberately.
- Preserve user data, existing changes, and project-specific instructions.
- Prefer focused, verifiable changes and report important outcomes clearly.
- Use a scratch or work area when the runtime provides one; keep temporary artifacts out of the user's project.
- Summarize or clear bulky intermediate results once their useful facts have been retained.
- Treat the context window as bounded: preserve decisions and evidence before reducing detail.
- Keep responses concise and use the user's language unless they request otherwise.`

function baseSection(
  mode: PromptCompositionMode,
  content: string | undefined,
): PromptSection | undefined {
  if (mode === 'bare') return undefined
  if (mode === 'default') {
    return {
      id: 'product-policy',
      content: PRODUCT_POLICY,
      placement: 'system',
      stability: 'static',
    }
  }
  if (content === undefined || content.trim().length === 0) {
    throw new Error(`${mode} prompt mode requires a base system prompt`)
  }
  return {
    id:
      mode === 'custom'
        ? 'custom-system'
        : mode === 'agent'
          ? 'agent-policy'
          : 'subagent-policy',
    content,
    placement: 'system',
    stability: 'session',
  }
}

function normalizedSections(
  sections: readonly PromptSection[],
  group: 'sessionSections' | 'tailSections',
): PromptSection[] {
  return sections
    .filter((section) => section.content.trim().length > 0)
    .map((section) => {
      if (!section.id.trim()) throw new Error('Prompt section id is required')
      if (group === 'sessionSections' && section.stability === 'volatile') {
        throw new Error(
          'sessionSections cannot contain volatile prompt sections',
        )
      }
      if (
        group === 'tailSections' &&
        section.placement === 'system' &&
        section.stability !== 'volatile'
      ) {
        throw new Error(
          'tailSections system entries must be volatile prompt sections',
        )
      }
      return { ...section }
    })
}

export class PromptComposer {
  compose(options: PromptCompositionOptions): PromptComposition {
    const base = baseSection(options.mode, options.baseSystemPrompt)
    const sessionSections = normalizedSections(
      options.sessionSections ?? [],
      'sessionSections',
    )
    const append = options.appendSystemPrompt?.trim()
      ? {
          id: 'append-system',
          content: options.appendSystemPrompt,
          placement: 'system' as const,
          stability: 'session' as const,
        }
      : undefined
    const tailSections = normalizedSections(
      options.tailSections ?? [],
      'tailSections',
    )
    const sections = [
      ...(base ? [base] : []),
      ...sessionSections,
      ...(append ? [append] : []),
      ...tailSections,
    ]
    const identities = new Set<string>()
    for (const section of sections) {
      if (identities.has(section.id)) {
        throw new Error(`Duplicate prompt section ${section.id}`)
      }
      identities.add(section.id)
    }
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
      sections,
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
}
