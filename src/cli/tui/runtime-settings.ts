import {
  CLAUDE_2_1_208_CONFIG_SETTINGS,
  configSettingValue,
  loadConfigSettings,
  type ConfigSettingsTarget,
  type ConfigSettingsSnapshot,
  type ConfigValue,
} from './config-settings.js'
import type { CliControls } from '../protocol.js'

export interface PraxisRuntimeSettings {
  tui: 'default' | 'fullscreen'
  autoCompact: boolean
  switchModelsOnFlag: boolean
  tips: boolean
  reduceMotion: boolean
  thinking: boolean
  recap: boolean
  checkpoints: boolean
  workflows: boolean
  workflowKeywordTriggerEnabled: boolean
  workflowSizeGuideline: 'unrestricted' | 'small' | 'medium' | 'large'
  verbose: boolean
  progressBar: boolean
  turnDuration: boolean
  permissionMode: 'default' | 'plan' | 'acceptEdits' | 'auto' | 'dontAsk'
  worktreeBaseRef: 'fresh' | 'head'
  useAutoModeDuringPlan: boolean
  gitignore: boolean
  copyFullResponse: boolean
  defaultToAgentsView: boolean
  leftArrowOpensAgents: boolean
  autoUpdatesChannel: 'latest' | 'stable'
  theme: string
  notifChannel: string
  outputStyle: 'default' | 'Proactive' | 'Explanatory' | 'Learning'
  language: string
  editor: 'normal' | 'vim'
  askUserQuestionTimeout: 'never' | '60s' | '5m' | '10m'
  externalEditorContext: boolean
  prStatus: boolean
  model: string
}

function value(snapshot: ConfigSettingsSnapshot, id: string): ConfigValue {
  const definition = CLAUDE_2_1_208_CONFIG_SETTINGS.find(
    (candidate) => candidate.id === id,
  )
  if (!definition) throw new Error(`Unknown runtime setting: ${id}`)
  return configSettingValue(snapshot, definition)
}

export function projectRuntimeSettings(
  snapshot: ConfigSettingsSnapshot,
): PraxisRuntimeSettings {
  return {
    tui: value(snapshot, 'tui') as PraxisRuntimeSettings['tui'],
    autoCompact: value(snapshot, 'autoCompact') as boolean,
    switchModelsOnFlag: value(snapshot, 'switchModelsOnFlag') as boolean,
    tips: value(snapshot, 'tips') as boolean,
    reduceMotion: value(snapshot, 'reduceMotion') as boolean,
    thinking: value(snapshot, 'thinking') as boolean,
    recap: value(snapshot, 'recap') as boolean,
    checkpoints: value(snapshot, 'checkpoints') as boolean,
    workflows: value(snapshot, 'workflows') as boolean,
    workflowKeywordTriggerEnabled: value(
      snapshot,
      'workflowKeywordTriggerEnabled',
    ) as boolean,
    workflowSizeGuideline: value(
      snapshot,
      'workflowSizeGuideline',
    ) as PraxisRuntimeSettings['workflowSizeGuideline'],
    verbose: value(snapshot, 'verbose') as boolean,
    progressBar: value(snapshot, 'progressBar') as boolean,
    turnDuration: value(snapshot, 'turnDuration') as boolean,
    permissionMode: value(
      snapshot,
      'permissionMode',
    ) as PraxisRuntimeSettings['permissionMode'],
    worktreeBaseRef: value(
      snapshot,
      'worktreeBaseRef',
    ) as PraxisRuntimeSettings['worktreeBaseRef'],
    useAutoModeDuringPlan: value(snapshot, 'useAutoModeDuringPlan') as boolean,
    gitignore: value(snapshot, 'gitignore') as boolean,
    copyFullResponse: value(snapshot, 'copyFullResponse') as boolean,
    defaultToAgentsView: value(snapshot, 'defaultToAgentsView') as boolean,
    leftArrowOpensAgents: value(snapshot, 'leftArrowOpensAgents') as boolean,
    autoUpdatesChannel: value(
      snapshot,
      'autoUpdatesChannel',
    ) as PraxisRuntimeSettings['autoUpdatesChannel'],
    theme: value(snapshot, 'theme') as string,
    notifChannel: value(snapshot, 'notifChannel') as string,
    outputStyle: value(
      snapshot,
      'outputStyle',
    ) as PraxisRuntimeSettings['outputStyle'],
    language: value(snapshot, 'language') as string,
    editor: value(snapshot, 'editor') as PraxisRuntimeSettings['editor'],
    askUserQuestionTimeout: value(
      snapshot,
      'askUserQuestionTimeout',
    ) as PraxisRuntimeSettings['askUserQuestionTimeout'],
    externalEditorContext: value(snapshot, 'externalEditorContext') as boolean,
    prStatus: value(snapshot, 'prStatus') as boolean,
    model: value(snapshot, 'model') as string,
  }
}

export async function loadRuntimeSettings(
  target?: ConfigSettingsTarget,
): Promise<PraxisRuntimeSettings> {
  return projectRuntimeSettings(await loadConfigSettings(target))
}

export function runtimeSettingsSystemPrompt(
  settings: PraxisRuntimeSettings | undefined,
): string | undefined {
  if (!settings) return undefined
  const sections = [
    settings.outputStyle === 'default'
      ? null
      : `Output style: ${settings.outputStyle}. Adapt explanations and initiative to this style.`,
    settings.language === 'default'
      ? null
      : `Respond in the user's configured language: ${settings.language}.`,
    settings.verbose
      ? 'Provide enough operational detail for the interactive verbose transcript; include exact tool and implementation outcomes when useful.'
      : null,
    settings.workflowKeywordTriggerEnabled
      ? null
      : 'Do not treat "ultracode" as a dynamic-workflow trigger unless the user explicitly requests a workflow.',
    settings.workflowSizeGuideline === 'unrestricted'
      ? null
      : `When creating a dynamic workflow, prefer a ${settings.workflowSizeGuideline} workflow unless the user explicitly requests otherwise.`,
  ].filter((section): section is string => section !== null)
  return sections.length > 0 ? sections.join('\n') : undefined
}

export function applyRuntimeSettingDefaults(
  controls: CliControls,
  settings: PraxisRuntimeSettings | undefined,
): CliControls {
  if (!settings) return controls
  return {
    ...controls,
    ...(settings.model !== 'default' && controls.model === undefined
      ? { model: settings.model }
      : {}),
    ...(controls.permissionMode === 'default'
      ? { permissionMode: settings.permissionMode }
      : {}),
    ...(controls.thinking === undefined
      ? { thinking: settings.thinking ? 'enabled' : 'disabled' }
      : {}),
  }
}
