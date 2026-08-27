import type { JsonResource } from '../core/resources.js'
import type {
  ModelMessage,
  ModelProvider,
  ModelToolCall,
  PermissionDecision,
} from '../core/runtime.js'

export interface ClaudeAutoModeConfig {
  allow: readonly string[]
  softDeny: readonly string[]
  hardDeny: readonly string[]
  environment: readonly string[]
  classifyAllShell: boolean
}

export interface ClaudeAutoClassifierInput {
  call: ModelToolCall
  cwd: string
  messages: readonly ModelMessage[]
  config: ClaudeAutoModeConfig
}

export type ClaudeAutoClassifier = (
  input: ClaudeAutoClassifierInput,
) => Promise<PermissionDecision>

const DEFAULT_AUTO_MODE_CONFIG: ClaudeAutoModeConfig = {
  allow: [
    'Read-only project inspection and local development operations',
    'Routine retries after transient tool failures',
  ],
  softDeny: [
    'Actions that modify files outside the active project',
    'Actions that publish data or change external systems',
  ],
  hardDeny: [
    'Credential exfiltration or unauthorized access',
    'Disabling permission, sandbox, or audit controls',
  ],
  environment: [
    'Single local developer working in the active project',
    'No enterprise policy or shared-user context is configured',
  ],
  classifyAllShell: false,
}

export function defaultClaudeAutoModeConfig(): ClaudeAutoModeConfig {
  return {
    allow: [...DEFAULT_AUTO_MODE_CONFIG.allow],
    softDeny: [...DEFAULT_AUTO_MODE_CONFIG.softDeny],
    hardDeny: [...DEFAULT_AUTO_MODE_CONFIG.hardDeny],
    environment: [...DEFAULT_AUTO_MODE_CONFIG.environment],
    classifyAllShell: DEFAULT_AUTO_MODE_CONFIG.classifyAllShell,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((item): item is string => typeof item === 'string')
}

function configuredList(
  value: unknown,
  defaults: readonly string[],
): readonly string[] {
  const values = stringList(value)
  if (!values) return defaults
  return values.includes('$defaults')
    ? [...defaults, ...values.filter((item) => item !== '$defaults')]
    : values
}

export function loadClaudeAutoModeConfig(
  settings: readonly JsonResource[],
): ClaudeAutoModeConfig {
  let config = defaultClaudeAutoModeConfig()
  for (const resource of settings) {
    if (!isRecord(resource.value) || !isRecord(resource.value.autoMode)) {
      continue
    }
    const source = resource.value.autoMode
    config = {
      allow: configuredList(source.allow, config.allow),
      softDeny: configuredList(source.soft_deny, config.softDeny),
      hardDeny: configuredList(source.hard_deny, config.hardDeny),
      environment: configuredList(source.environment, config.environment),
      classifyAllShell:
        typeof source.classifyAllShell === 'boolean'
          ? source.classifyAllShell
          : config.classifyAllShell,
    }
  }
  return config
}

function parseDecision(text: string): PermissionDecision {
  const candidate = text.match(/\{[\s\S]*\}/u)?.[0]
  if (!candidate) throw new Error('Auto classifier returned no JSON decision')
  let value: unknown
  try {
    value = JSON.parse(candidate)
  } catch (error) {
    throw new Error('Auto classifier returned malformed JSON', { cause: error })
  }
  if (!isRecord(value)) throw new Error('Auto classifier returned invalid JSON')
  const behavior = value.behavior ?? value.decision
  if (behavior !== 'allow' && behavior !== 'ask' && behavior !== 'deny') {
    throw new Error('Auto classifier returned an invalid permission behavior')
  }
  const reason = typeof value.reason === 'string' ? value.reason : undefined
  if (behavior === 'deny') {
    return {
      behavior,
      reason: reason ?? 'Action denied by auto mode classifier',
    }
  }
  if (behavior === 'ask') return { behavior, ...(reason ? { reason } : {}) }
  return { behavior: 'allow' }
}

function compactMessages(messages: readonly ModelMessage[]): string {
  return JSON.stringify(
    messages.slice(-24).map((message) => ({
      role: message.role,
      content: message.content.slice(0, 8_000),
      ...(message.role === 'assistant' && message.toolCalls
        ? { toolCalls: message.toolCalls }
        : {}),
      ...(message.role === 'tool'
        ? { toolCallId: message.toolCallId, isError: message.isError }
        : {}),
    })),
  )
}

export function createClaudeModelAutoClassifier(
  provider: ModelProvider,
): ClaudeAutoClassifier {
  return async ({ call, cwd, messages, config }) => {
    const request: ModelMessage[] = [
      {
        role: 'system',
        content: [
          'You are Praxis permission auto-mode classifier.',
          'Return exactly one JSON object: {"behavior":"allow|ask|deny","reason":"short reason"}.',
          'Hard deny rules are unconditional. Soft deny rules require denying unless active user intent clearly authorizes the action.',
          'Allow rules describe routine actions. Treat missing or ambiguous context as ask or deny, never allow.',
          `Working directory: ${cwd}`,
          `Environment rules: ${JSON.stringify(config.environment)}`,
          `Allow rules: ${JSON.stringify(config.allow)}`,
          `Soft deny rules: ${JSON.stringify(config.softDeny)}`,
          `Hard deny rules: ${JSON.stringify(config.hardDeny)}`,
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          action: { name: call.name, input: call.input },
          recentMessages: compactMessages(messages),
        }),
      },
    ]
    let text = ''
    for await (const event of provider.complete({ messages: request })) {
      if (event.type === 'text-delta') text += event.delta
      if (event.type === 'tool-call') {
        throw new Error('Auto classifier returned a tool call')
      }
    }
    return parseDecision(text)
  }
}
