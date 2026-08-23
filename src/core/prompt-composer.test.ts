import { describe, expect, it } from 'vitest'

import { projectContextSnapshot } from './context.js'
import { PromptComposer, type PromptSection } from './prompt-composer.js'

const section = (
  id: string,
  stability: PromptSection['stability'] = 'session',
  placement: PromptSection['placement'] = 'system',
): PromptSection => ({
  id,
  content: id.toUpperCase(),
  stability,
  placement,
})

describe('PromptComposer', () => {
  it('returns an ordered structured manifest for the default prompt', () => {
    const composed = new PromptComposer().compose({
      mode: 'default',
      sessionSections: [section('instructions'), section('environment')],
      tailSections: [section('runtime-tail', 'volatile')],
    })

    expect(
      composed.sections.map(({ id, stability, placement }) => ({
        id,
        stability,
        placement,
      })),
    ).toEqual([
      { id: 'product-policy', stability: 'static', placement: 'system' },
      { id: 'instructions', stability: 'session', placement: 'system' },
      { id: 'environment', stability: 'session', placement: 'system' },
      { id: 'runtime-tail', stability: 'volatile', placement: 'system' },
    ])
    const projection = projectContextSnapshot(composed)
    expect(projection.stableSystemSectionCount).toBe(3)
    expect(projection.systemMessages.map((message) => message.content)).toEqual(
      [
        expect.stringContaining('Praxis'),
        'INSTRUCTIONS',
        'ENVIRONMENT',
        'RUNTIME-TAIL',
      ],
    )
    const policy = projection.systemMessages[0]?.content ?? ''
    expect(policy).toMatch(/coding agent/iu)
    expect(policy).toMatch(/scratch or work area/iu)
    expect(policy).toMatch(/summarize or clear/iu)
    expect(policy).toMatch(/context window as bounded/iu)
    expect(policy).toMatch(/user's language/iu)
  })

  it('replaces the default base, layers append content before volatile tails, and supports bare mode', () => {
    const composer = new PromptComposer()
    const custom = composer.compose({
      mode: 'custom',
      baseSystemPrompt: 'CUSTOM',
      appendSystemPrompt: 'APPEND',
      sessionSections: [section('instructions')],
      tailSections: [section('tail', 'volatile')],
    })
    const bare = composer.compose({
      mode: 'bare',
      appendSystemPrompt: 'EXPLICIT_ONLY',
    })

    expect(custom.sections.map((item) => item.id)).toEqual([
      'custom-system',
      'instructions',
      'append-system',
      'tail',
    ])
    expect(JSON.stringify(custom.sections)).not.toContain('product-policy')
    expect(bare.sections).toEqual([
      {
        id: 'append-system',
        content: 'EXPLICIT_ONLY',
        placement: 'system',
        stability: 'session',
      },
    ])
  })

  it('keeps subagent policy explicit and projects first-user sections separately', () => {
    const composed = new PromptComposer().compose({
      mode: 'subagent',
      baseSystemPrompt: 'SUBAGENT_POLICY',
      sessionSections: [section('skills')],
      tailSections: [section('relocated-runtime', 'session', 'first-user')],
    })

    expect(composed.sections.map((item) => item.id)).toEqual([
      'subagent-policy',
      'skills',
      'relocated-runtime',
    ])
    expect(
      projectContextSnapshot(composed).systemMessages.map(
        (message) => message.content,
      ),
    ).toEqual(['SUBAGENT_POLICY', 'SKILLS'])
    expect(projectContextSnapshot(composed).firstUserMessageContext).toBe(
      'RELOCATED-RUNTIME',
    )
  })

  it('identifies a selected main-agent policy without duplicating product policy', () => {
    const composed = new PromptComposer().compose({
      mode: 'agent',
      baseSystemPrompt: 'MAIN_AGENT_POLICY',
      sessionSections: [section('instructions')],
    })

    expect(composed.sections.map((item) => item.id)).toEqual([
      'agent-policy',
      'instructions',
    ])
    expect(JSON.stringify(composed.sections)).not.toContain('product-policy')
  })

  it('owns identities, placement, and lifetime for every turn context input', () => {
    const composed = new PromptComposer().compose({
      mode: 'default',
      turn: {
        planMode: 'PLAN',
        sessionMemory: 'MEMORY',
        briefOutput: true,
        structuredOutput: true,
      },
    })

    expect(composed.sections.slice(-4)).toEqual([
      {
        id: 'plan-mode',
        content: 'PLAN',
        placement: 'system',
        stability: 'volatile',
      },
      {
        id: 'session-memory',
        content: 'MEMORY',
        placement: 'system',
        stability: 'volatile',
      },
      {
        id: 'brief-output',
        content: expect.stringContaining('SendUserMessage'),
        placement: 'system',
        stability: 'volatile',
      },
      {
        id: 'structured-output',
        content: expect.stringContaining('requested JSON Schema'),
        placement: 'system',
        stability: 'volatile',
      },
    ])
    expect(projectContextSnapshot(composed).stableSystemSectionCount).toBe(1)
  })

  it('rejects duplicate identities and invalid stability ordering', () => {
    const composer = new PromptComposer()

    expect(() =>
      composer.compose({
        mode: 'default',
        sessionSections: [section('duplicate'), section('duplicate')],
      }),
    ).toThrow('Duplicate context section duplicate')
    expect(() =>
      composer.compose({
        mode: 'default',
        sessionSections: [section('unstable', 'volatile')],
      }),
    ).toThrow('sessionSections cannot contain volatile prompt sections')
  })
})
