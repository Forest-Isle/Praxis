export type AnthropicModelAliasOverrides = Readonly<
  Partial<Record<'sonnet' | 'opus' | 'haiku', string>>
>

const DEFAULTS: Readonly<Record<'sonnet' | 'opus' | 'haiku', string>> = {
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
  haiku: 'claude-haiku-4-5-20251001',
}

const ENVIRONMENT_KEYS = {
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
} as const

export function anthropicModelAliasOverridesFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): AnthropicModelAliasOverrides {
  const overrides: Partial<Record<'sonnet' | 'opus' | 'haiku', string>> = {}
  for (const family of ['sonnet', 'opus', 'haiku'] as const) {
    const value = environment[ENVIRONMENT_KEYS[family]]
    if (value === undefined || value.trim().length === 0) continue
    if (value.length > 256) {
      throw new Error(
        `${ENVIRONMENT_KEYS[family]} must be at most 256 characters`,
      )
    }
    overrides[family] = value
  }
  return overrides
}

export function resolveAnthropicModelAlias(
  model: string,
  overrides: AnthropicModelAliasOverrides = {},
): string {
  const longContext = model.endsWith('[1m]')
  const family =
    model === 'best'
      ? 'opus'
      : longContext
        ? model.slice(0, -'[1m]'.length)
        : model
  if (family !== 'sonnet' && family !== 'opus' && family !== 'haiku') {
    return model
  }
  if (longContext && family === 'haiku') return model
  const resolved = overrides[family] ?? DEFAULTS[family]
  if (!longContext || resolved.endsWith('[1m]')) return resolved
  return `${resolved}[1m]`
}
