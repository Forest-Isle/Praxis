import {
  createContextSnapshot,
  type ContextAssembler,
  type ContextAssemblyOptions,
  type ContextCompositionMode,
  type ContextSection,
  type ContextSnapshot,
  type TurnContextInputs,
} from './context.js'

export type PromptSectionStability = ContextSection['stability']
export type PromptSectionPlacement = ContextSection['placement']
export type PromptCompositionMode = ContextCompositionMode

export type PromptSection = ContextSection
export type PromptComposition = ContextSnapshot

export interface PromptCompositionOptions {
  mode: PromptCompositionMode
  baseSystemPrompt?: string
  appendSystemPrompt?: string
  sessionSections?: readonly PromptSection[]
  tailSections?: readonly PromptSection[]
  turn?: TurnContextInputs
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

const BRIEF_OUTPUT_POLICY =
  'When brief mode is enabled, SendUserMessage is the primary user-visible reply channel. Use it for the answer, progress checkpoints, and blockers. Set status to normal for a direct reply and proactive for an unsolicited update.'

const STRUCTURED_OUTPUT_POLICY =
  'You MUST call StructuredOutput exactly once at the end with a value matching the requested JSON Schema.'

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

function turnSections(turn: TurnContextInputs | undefined): PromptSection[] {
  if (!turn) return []
  return [
    ...(turn.planMode?.trim()
      ? [
          {
            id: 'plan-mode',
            content: turn.planMode,
            placement: 'system' as const,
            stability: 'volatile' as const,
          },
        ]
      : []),
    ...(turn.sessionMemory?.trim()
      ? [
          {
            id: 'session-memory',
            content: turn.sessionMemory,
            placement: 'system' as const,
            stability: 'volatile' as const,
          },
        ]
      : []),
    ...(turn.briefOutput
      ? [
          {
            id: 'brief-output',
            content: BRIEF_OUTPUT_POLICY,
            placement: 'system' as const,
            stability: 'volatile' as const,
          },
        ]
      : []),
    ...(turn.structuredOutput
      ? [
          {
            id: 'structured-output',
            content: STRUCTURED_OUTPUT_POLICY,
            placement: 'system' as const,
            stability: 'volatile' as const,
          },
        ]
      : []),
  ]
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
      [...(options.tailSections ?? []), ...turnSections(options.turn)],
      'tailSections',
    )
    const sections = [
      ...(base ? [base] : []),
      ...sessionSections,
      ...(append ? [append] : []),
      ...tailSections,
    ]
    return createContextSnapshot(sections)
  }
}

const defaultContextAssembler: ContextAssembler = {
  async assemble(options: ContextAssemblyOptions = {}) {
    return new PromptComposer().compose({
      mode: options.mode ?? 'bare',
      ...(options.baseSystemPrompt === undefined
        ? {}
        : { baseSystemPrompt: options.baseSystemPrompt }),
      ...(options.turn === undefined ? {} : { turn: options.turn }),
    })
  },
}

export async function assembleContextSnapshot(
  assembler: ContextAssembler | undefined,
  options: ContextAssemblyOptions = {},
): Promise<ContextSnapshot> {
  return (assembler ?? defaultContextAssembler).assemble(options)
}
