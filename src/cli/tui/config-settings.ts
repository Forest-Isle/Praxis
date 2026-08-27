import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { writeFileAtomically } from '../../platform/atomic-write.js'
import { resolveDataPlaneRoot } from '../../persistence/data-plane.js'
import {
  ExclusiveFileLease,
  type ExclusiveFileLeaseHandle,
} from '../../platform/exclusive-file-lease.js'

export type ConfigStorageScope = 'settings' | 'state'
export type ConfigValue = boolean | string

export interface ConfigSettingDefinition {
  id: string
  nativeKey: string
  label: string
  scope: ConfigStorageScope
  path: readonly string[]
  values: readonly ConfigValue[] | 'language'
  defaultValue: ConfigValue
  runtimeStatus: 'integrated' | 'interactive-integration' | 'not-applicable'
  runtimeConsumer: string
  applicabilityReason?: string
}

export interface ConfigSettingsSnapshot {
  settings: Readonly<Record<string, unknown>>
  state: Readonly<Record<string, unknown>>
}

export interface ConfigSettingsLocation {
  configRoot: string
  statePath: string
}

export type ConfigSettingsTarget = string | ConfigSettingsLocation

const booleanValues = [true, false] as const

export const CLAUDE_2_1_208_CONFIG_SETTINGS = [
  setting(
    'autoCompact',
    'Auto-compact',
    'settings',
    ['autoCompactEnabled'],
    booleanValues,
    true,
    'compaction threshold policy',
  ),
  setting(
    'switchModelsOnFlag',
    'Switch models when a message is flagged',
    'settings',
    ['switchModelsOnFlag'],
    booleanValues,
    true,
    'provider capability-aware model fallback',
  ),
  setting(
    'tips',
    'Show tips',
    'settings',
    ['spinnerTipsEnabled'],
    booleanValues,
    true,
    'interactive spinner tips',
  ),
  setting(
    'reduceMotion',
    'Reduce motion',
    'settings',
    ['prefersReducedMotion'],
    booleanValues,
    false,
    'all animated TUI surfaces',
  ),
  setting(
    'thinking',
    'Thinking mode',
    'settings',
    ['alwaysThinkingEnabled'],
    booleanValues,
    true,
    'interactive thinking controls and provider adapter',
  ),
  setting(
    'recap',
    'Session recap',
    'settings',
    ['awaySummaryEnabled'],
    booleanValues,
    true,
    'interactive session resume recap',
  ),
  setting(
    'checkpoints',
    'Rewind code (checkpoints)',
    'settings',
    ['fileCheckpointingEnabled'],
    booleanValues,
    true,
    'file-history snapshot and rewind runtime',
  ),
  setting(
    'workflows',
    'Dynamic workflows',
    'settings',
    ['enableWorkflows'],
    booleanValues,
    true,
    'workflow tool exposure and SessionService',
  ),
  setting(
    'workflowKeywordTriggerEnabled',
    'Ultracode keyword trigger',
    'settings',
    ['workflowKeywordTriggerEnabled'],
    booleanValues,
    true,
    'workflow keyword dispatcher',
  ),
  setting(
    'workflowSizeGuideline',
    'Dynamic workflow size',
    'state',
    ['workflowSizeGuideline'],
    ['unrestricted', 'small', 'medium', 'large'],
    'unrestricted',
    'workflow planner sizing guidance',
  ),
  setting(
    'verbose',
    'Verbose output',
    'settings',
    ['verbose'],
    booleanValues,
    false,
    'interactive transcript detail and protocol diagnostics',
  ),
  setting(
    'progressBar',
    'Terminal progress bar',
    'settings',
    ['terminalProgressBarEnabled'],
    booleanValues,
    true,
    'terminal progress renderer',
  ),
  setting(
    'turnDuration',
    'Show turn duration',
    'settings',
    ['showTurnDuration'],
    booleanValues,
    true,
    'interactive turn footer',
  ),
  setting(
    'permissionMode',
    'Default permission mode',
    'settings',
    ['permissions', 'defaultMode'],
    ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk'],
    'default',
    'startup permission mode selection',
  ),
  setting(
    'worktreeBaseRef',
    'Worktree base ref',
    'settings',
    ['worktree', 'baseRef'],
    ['fresh', 'head'],
    'fresh',
    'worktree creation runtime',
  ),
  setting(
    'useAutoModeDuringPlan',
    'Use auto mode during plan',
    'settings',
    ['useAutoModeDuringPlan'],
    booleanValues,
    true,
    'plan approval permission transition',
  ),
  setting(
    'gitignore',
    'Respect .gitignore in file picker',
    'state',
    ['respectGitignore'],
    booleanValues,
    true,
    'interactive file picker',
  ),
  setting(
    'copyFullResponse',
    'Skip the /copy picker',
    'state',
    ['copyFullResponse'],
    booleanValues,
    false,
    '/copy local command',
  ),
  setting(
    'defaultToAgentsView',
    'Open agents view by default',
    'state',
    ['defaultToAgentsView'],
    booleanValues,
    false,
    'interactive agents dashboard',
  ),
  setting(
    'leftArrowOpensAgents',
    '← opens agents',
    'state',
    ['leftArrowOpensAgents'],
    booleanValues,
    true,
    'global interactive key dispatcher',
  ),
  setting(
    'autoUpdatesChannel',
    'Auto-update channel',
    'settings',
    ['autoUpdatesChannel'],
    ['latest', 'stable'],
    'latest',
    'self-update policy',
  ),
  setting(
    'theme',
    'Theme',
    'settings',
    ['theme'],
    [
      'auto',
      'dark',
      'light',
      'light-daltonized',
      'dark-daltonized',
      'light-ansi',
      'dark-ansi',
    ],
    'auto',
    'Stage 109 theme runtime',
  ),
  setting(
    'notifChannel',
    'Local notifications',
    'settings',
    ['preferredNotifChannel'],
    [
      'auto',
      'iterm2',
      'terminal_bell',
      'iterm2_with_bell',
      'kitty',
      'ghostty',
      'notifications_disabled',
    ],
    'auto',
    'task and permission notification dispatcher',
  ),
  setting(
    'outputStyle',
    'Output style',
    'settings',
    ['outputStyle'],
    ['default', 'Proactive', 'Explanatory', 'Learning'],
    'default',
    'system-prompt output-style projection',
  ),
  setting(
    'language',
    'Language',
    'settings',
    ['language'],
    'language',
    'default',
    'system-prompt language projection',
  ),
  setting(
    'editor',
    'Editor mode',
    'settings',
    ['editorMode'],
    ['normal', 'vim'],
    'normal',
    'interactive composer editor mode',
  ),
  setting(
    'askUserQuestionTimeout',
    'Question auto-continue timeout',
    'settings',
    ['askUserQuestionTimeout'],
    ['never', '60s', '5m', '10m'],
    'never',
    'AskUserQuestion decision timer',
  ),
  setting(
    'externalEditorContext',
    'Show last response in external editor',
    'state',
    ['externalEditorContext'],
    booleanValues,
    false,
    'external editor prompt projection',
  ),
  setting(
    'prStatus',
    'Show PR status footer',
    'state',
    ['prStatusFooterEnabled'],
    booleanValues,
    true,
    'interactive repository footer',
  ),
  setting(
    'model',
    'Model',
    'settings',
    ['model'],
    [
      'default',
      'sonnet',
      'opus',
      'haiku',
      'best',
      'sonnet[1m]',
      'opus[1m]',
      'opusplan',
    ],
    'default',
    'startup provider model selection',
  ),
  setting(
    'tui',
    'TUI renderer',
    'settings',
    ['tui'],
    ['default', 'fullscreen'],
    'default',
    'interactive renderer mode',
  ),
] as const satisfies readonly ConfigSettingDefinition[]

function setting(
  nativeKey: string,
  label: string,
  scope: ConfigStorageScope,
  path: readonly string[],
  values: readonly ConfigValue[] | 'language',
  defaultValue: ConfigValue,
  runtimeConsumer: string,
): ConfigSettingDefinition {
  const integrated = new Set([
    'autoCompact',
    'thinking',
    'checkpoints',
    'workflows',
    'permissionMode',
    'worktreeBaseRef',
    'gitignore',
    'theme',
    'outputStyle',
    'language',
    'model',
  ]).has(nativeKey)
  const notApplicable = nativeKey === 'switchModelsOnFlag'
  return {
    id: nativeKey,
    nativeKey,
    label,
    scope,
    path,
    values,
    defaultValue,
    runtimeStatus: integrated
      ? 'integrated'
      : notApplicable
        ? 'not-applicable'
        : 'interactive-integration',
    runtimeConsumer,
    ...(notApplicable
      ? {
          applicabilityReason:
            'Claude subscription flag fallback is outside the API-provider, subscription-auth-free Praxis boundary',
        }
      : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function resolveConfigSettingsLocation(
  target?: ConfigSettingsTarget,
): ConfigSettingsLocation {
  if (typeof target === 'object') return target
  if (typeof target === 'string')
    return { configRoot: target, statePath: join(target, 'state.json') }
  const configRoot = resolveDataPlaneRoot()
  return { configRoot, statePath: join(configRoot, 'state.json') }
}

function configPath(
  location: ConfigSettingsLocation,
  scope: ConfigStorageScope,
): string {
  return scope === 'settings'
    ? join(location.configRoot, 'settings.json')
    : location.statePath
}

async function readObject(path: string): Promise<{
  value: Record<string, unknown>
  fingerprint: string
}> {
  try {
    const source = await readRegularSource(path)
    if (source === undefined)
      return { value: {}, fingerprint: sourceFingerprint() }
    const value: unknown = JSON.parse(source)
    if (!isRecord(value))
      throw new Error(`JSON root must be an object: ${path}`)
    return { value, fingerprint: sourceFingerprint(source) }
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error(`Invalid JSON: ${path}`, { cause: error })
    throw error
  }
}

async function readRegularSource(path: string): Promise<string | undefined> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    if (code === 'ELOOP')
      throw new Error(`Config path must be a regular file: ${path}`)
    throw error
  }
  try {
    if (!(await handle.stat()).isFile())
      throw new Error(`Config path must be a regular file: ${path}`)
    return handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

function sourceFingerprint(source?: string): string {
  return source === undefined
    ? 'missing'
    : createHash('sha256').update(source).digest('hex')
}

async function fingerprintUnchanged(
  path: string,
  expected: string,
): Promise<boolean> {
  const source = await readRegularSource(path)
  return sourceFingerprint(source) === expected
}

function valueAtPath(
  source: Readonly<Record<string, unknown>>,
  path: readonly string[],
): unknown {
  let current: unknown = source
  for (const segment of path) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

function withValueAtPath(
  source: Readonly<Record<string, unknown>>,
  path: readonly string[],
  value: ConfigValue,
): Record<string, unknown> {
  const [head, ...tail] = path
  if (!head) throw new Error('Config setting path cannot be empty')
  if (tail.length === 0) return { ...source, [head]: value }
  const storedChild = source[head]
  if (storedChild !== undefined && !isRecord(storedChild)) {
    throw new Error(
      `Config setting path ${path.join('.')} crosses a non-object`,
    )
  }
  const child = storedChild ?? {}
  return { ...source, [head]: withValueAtPath(child, tail, value) }
}

function validValue(
  definition: ConfigSettingDefinition,
  value: unknown,
): value is ConfigValue {
  if (definition.values === 'language' || definition.id === 'model')
    return (
      typeof value === 'string' &&
      value.trim().length > 0 &&
      value.length <= 256
    )
  return definition.values.includes(value as never)
}

export function configSettingDefinition(
  id: string,
): ConfigSettingDefinition | undefined {
  return CLAUDE_2_1_208_CONFIG_SETTINGS.find(
    (definition) => definition.id === id || definition.nativeKey === id,
  )
}

export function configSettingValue(
  snapshot: ConfigSettingsSnapshot,
  definition: ConfigSettingDefinition,
): ConfigValue {
  const source =
    definition.scope === 'settings' ? snapshot.settings : snapshot.state
  const stored = valueAtPath(source, definition.path)
  return validValue(definition, stored) ? stored : definition.defaultValue
}

export async function loadConfigSettings(
  target?: ConfigSettingsTarget,
): Promise<ConfigSettingsSnapshot> {
  const location = resolveConfigSettingsLocation(target)
  const [settings, state] = await Promise.all([
    readObject(configPath(location, 'settings')),
    readObject(configPath(location, 'state')),
  ])
  return { settings: settings.value, state: state.value }
}

async function acquireLease(
  location: ConfigSettingsLocation,
  scope: ConfigStorageScope,
): Promise<ExclusiveFileLeaseHandle> {
  const path = configPath(location, scope)
  const lockParent = await realpath(dirname(path)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return dirname(path)
      throw error
    },
  )
  const lease = new ExclusiveFileLease(
    scope === 'settings'
      ? join(lockParent, '.praxis-settings.lock')
      : join(lockParent, '.praxis-state.lock'),
  )
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const handle = await lease.tryAcquire()
    if (handle) return handle
    await setTimeout(5)
  }
  throw new Error(`Config write lock timed out: ${path}`)
}

export async function saveConfigSetting(
  id: string,
  value: ConfigValue,
  target?: ConfigSettingsTarget,
  hooks: { afterValidation?: () => Promise<void> } = {},
): Promise<ConfigSettingsSnapshot> {
  const definition = configSettingDefinition(id)
  if (!definition) throw new Error(`Unknown Claude config setting: ${id}`)
  if (!validValue(definition, value))
    throw new Error(
      `Invalid value for Claude config setting ${id}: ${String(value)}`,
    )

  const location = resolveConfigSettingsLocation(target)
  await loadConfigSettings(location)

  const path = configPath(location, definition.scope)
  const handle = await acquireLease(location, definition.scope)
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const settingsPath = configPath(location, 'settings')
      const statePath = configPath(location, 'state')
      const [settings, state] = await Promise.all([
        readObject(settingsPath),
        readObject(statePath),
      ])
      const current = definition.scope === 'settings' ? settings : state
      const next = withValueAtPath(current.value, definition.path, value)
      const committed = await writeFileAtomically(
        path,
        `${JSON.stringify(next, null, 2)}\n`,
        {
          beforeCommit: async () => {
            const unchanged =
              (await fingerprintUnchanged(
                settingsPath,
                settings.fingerprint,
              )) && (await fingerprintUnchanged(statePath, state.fingerprint))
            if (!unchanged) return false
            await hooks.afterValidation?.()
            return (
              (await fingerprintUnchanged(
                settingsPath,
                settings.fingerprint,
              )) && (await fingerprintUnchanged(statePath, state.fingerprint))
            )
          },
        },
      )
      if (committed) return loadConfigSettings(location)
    }
    throw new Error(`Config changed concurrently: ${path}`)
  } finally {
    await handle.release()
  }
}
