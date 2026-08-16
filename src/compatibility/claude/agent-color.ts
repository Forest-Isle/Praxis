import type { ClaudeTranscriptEntry } from './schema.js'

export const AGENT_COLORS = [
  'red',
  'blue',
  'green',
  'yellow',
  'purple',
  'orange',
  'pink',
  'cyan',
] as const

export type AgentColorName = (typeof AGENT_COLORS)[number]

export const AGENT_COLOR_DEFAULT = 'default' as const

export type AgentColorValue = AgentColorName | typeof AGENT_COLOR_DEFAULT

export const AGENT_COLOR_VALUES: readonly AgentColorValue[] = [
  ...AGENT_COLORS,
  AGENT_COLOR_DEFAULT,
]

export const AGENT_COLOR_CHOICES = `${AGENT_COLORS.join(', ')}, ${AGENT_COLOR_DEFAULT}`

export const RESET_AGENT_COLOR_ALIASES = [
  AGENT_COLOR_DEFAULT,
  'reset',
  'none',
  'gray',
  'grey',
] as const

export function isAgentColorName(value: unknown): value is AgentColorName {
  return (
    typeof value === 'string' &&
    (AGENT_COLORS as readonly string[]).includes(value)
  )
}

export function isAgentColorValue(value: unknown): value is AgentColorValue {
  return (
    typeof value === 'string' &&
    (AGENT_COLOR_VALUES as readonly string[]).includes(value)
  )
}

export function normalizeAgentColorInput(input: string): string {
  return input.trim().toLowerCase()
}

export type AgentColorSelection =
  | { kind: 'color'; color: AgentColorName }
  | { kind: 'reset' }
  | { kind: 'invalid'; input: string }

export function parseAgentColorInput(input: string): AgentColorSelection {
  const normalized = normalizeAgentColorInput(input)
  if (normalized === '') {
    return { kind: 'color', color: randomAgentColor() }
  }
  if ((RESET_AGENT_COLOR_ALIASES as readonly string[]).includes(normalized)) {
    return { kind: 'reset' }
  }
  if (isAgentColorName(normalized)) {
    return { kind: 'color', color: normalized }
  }
  return { kind: 'invalid', input: normalized }
}

export function randomAgentColor(): AgentColorName {
  const index = Math.floor(Math.random() * AGENT_COLORS.length)
  const color = AGENT_COLORS[index]
  if (color === undefined) throw new Error('AGENT_COLORS must not be empty')
  return color
}

export function agentColorMessage(selection: AgentColorSelection): string {
  switch (selection.kind) {
    case 'color':
      return `Session color set to: ${selection.color}`
    case 'reset':
      return 'Session color reset to default'
    case 'invalid':
      return `Invalid color "${selection.input}". Available colors: ${AGENT_COLOR_CHOICES}`
  }
}

export function getClaudeEffectiveAgentColor(
  entries: readonly ClaudeTranscriptEntry[],
  sessionId: string,
): AgentColorName | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.type !== 'agent-color' || entry.sessionId !== sessionId) {
      continue
    }
    const color = entry.agentColor
    if (color === AGENT_COLOR_DEFAULT) return undefined
    if (isAgentColorName(color)) return color
  }
  return undefined
}
