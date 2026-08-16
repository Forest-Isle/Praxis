import { describe, expect, it, vi } from 'vitest'

import {
  AGENT_COLOR_CHOICES,
  AGENT_COLORS,
  agentColorMessage,
  getClaudeEffectiveAgentColor,
  normalizeAgentColorInput,
  parseAgentColorInput,
  randomAgentColor,
  RESET_AGENT_COLOR_ALIASES,
  type AgentColorSelection,
} from './agent-color.js'
import type { ClaudeTranscriptEntry } from './schema.js'

describe('agent-color', () => {
  it('defines the canonical ordered color list and reset aliases', () => {
    expect(AGENT_COLORS).toEqual([
      'red',
      'blue',
      'green',
      'yellow',
      'purple',
      'orange',
      'pink',
      'cyan',
    ])
    expect(RESET_AGENT_COLOR_ALIASES).toEqual([
      'default',
      'reset',
      'none',
      'gray',
      'grey',
    ])
    expect(AGENT_COLOR_CHOICES).toBe(
      'red, blue, green, yellow, purple, orange, pink, cyan, default',
    )
  })

  it('normalizes explicit colors with trim and lowercase', () => {
    expect(normalizeAgentColorInput('  PurPle  ')).toBe('purple')
    expect(parseAgentColorInput('  PURPLE  ')).toEqual({
      kind: 'color',
      color: 'purple',
    })
    expect(parseAgentColorInput('red')).toEqual({ kind: 'color', color: 'red' })
    expect(parseAgentColorInput('cyan')).toEqual({
      kind: 'color',
      color: 'cyan',
    })
  })

  it('treats empty input as a random color from the canonical list', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const selection = parseAgentColorInput('   ')
      expect(selection.kind).toBe('color')
      if (selection.kind !== 'color') throw new Error('unreachable')
      expect(AGENT_COLORS).toContain(selection.color)
    }
    expect(randomAgentColor()).toBeTypeOf('string')
    expect(AGENT_COLORS).toContain(randomAgentColor())
  })

  it('maps every Math.random bucket to the ordered palette', () => {
    const random = vi.spyOn(Math, 'random')
    try {
      for (const [index, color] of AGENT_COLORS.entries()) {
        random.mockReturnValue((index + 0.5) / AGENT_COLORS.length)
        expect(parseAgentColorInput('')).toEqual({ kind: 'color', color })
      }
    } finally {
      random.mockRestore()
    }
  })

  it('maps every reset alias to a reset selection', () => {
    for (const alias of RESET_AGENT_COLOR_ALIASES) {
      expect(parseAgentColorInput(alias)).toEqual({ kind: 'reset' })
      expect(parseAgentColorInput(`  ${alias.toUpperCase()} `)).toEqual({
        kind: 'reset',
      })
    }
  })

  it('rejects unknown colors with the normalized input', () => {
    expect(parseAgentColorInput('  Bogus  ')).toEqual({
      kind: 'invalid',
      input: 'bogus',
    })
    expect(parseAgentColorInput('yellowish')).toEqual({
      kind: 'invalid',
      input: 'yellowish',
    })
  })

  it('formats the exact session color messages', () => {
    const message = (selection: AgentColorSelection) =>
      agentColorMessage(selection)
    expect(message({ kind: 'color', color: 'purple' })).toBe(
      'Session color set to: purple',
    )
    expect(message({ kind: 'reset' })).toBe('Session color reset to default')
    expect(message({ kind: 'invalid', input: 'bogus' })).toBe(
      'Invalid color "bogus". Available colors: red, blue, green, yellow, purple, orange, pink, cyan, default',
    )
  })

  it('selects the last valid agent-color for a session and maps default to undefined', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const otherSessionId = '22222222-2222-4222-8222-222222222222'
    const entries: ClaudeTranscriptEntry[] = [
      { type: 'agent-color', agentColor: 'red', sessionId: otherSessionId },
      { type: 'mode', mode: 'normal', sessionId },
      { type: 'agent-color', agentColor: 'blue', sessionId },
      { type: 'agent-color', agentColor: 'orange', sessionId },
    ]
    expect(getClaudeEffectiveAgentColor(entries, sessionId)).toBe('orange')
    expect(getClaudeEffectiveAgentColor(entries, otherSessionId)).toBe('red')
    expect(
      getClaudeEffectiveAgentColor(
        [...entries, { type: 'agent-color', agentColor: 'default', sessionId }],
        sessionId,
      ),
    ).toBeUndefined()
    expect(
      getClaudeEffectiveAgentColor(
        [...entries, { type: 'agent-color', agentColor: 'bogus', sessionId }],
        sessionId,
      ),
    ).toBe('orange')
    expect(
      getClaudeEffectiveAgentColor(
        [{ type: 'mode', mode: 'normal', sessionId }],
        sessionId,
      ),
    ).toBeUndefined()
  })
})
