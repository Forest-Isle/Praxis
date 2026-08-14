import type { TranscriptItem } from './claude-style.js'
import type { PraxisRuntimeSettings } from './runtime-settings.js'

const SPINNER_TIPS = [
  'Tip: use /help to browse local commands.',
  'Tip: use @ to attach a file or an agent definition.',
  'Tip: press ctrl+o to expand the detailed transcript.',
  'Tip: use /compact to summarize a long conversation.',
] as const

export function spinnerTip(
  settings: Pick<PraxisRuntimeSettings, 'tips'>,
): string | undefined {
  if (!settings.tips) return undefined
  return SPINNER_TIPS[Math.floor(Date.now() / 8_000) % SPINNER_TIPS.length]
}

export function questionTimeoutMilliseconds(
  value: PraxisRuntimeSettings['askUserQuestionTimeout'],
): number | undefined {
  switch (value) {
    case '60s':
      return 60_000
    case '5m':
      return 5 * 60_000
    case '10m':
      return 10 * 60_000
    case 'never':
      return undefined
  }
}

export function workflowRuntimeInstructions(
  settings: Pick<
    PraxisRuntimeSettings,
    'workflows' | 'workflowKeywordTriggerEnabled' | 'workflowSizeGuideline'
  >,
): string | undefined {
  if (!settings.workflows) return undefined
  const keyword = settings.workflowKeywordTriggerEnabled
    ? 'Treat an explicit "ultracode" request as a request to consider a dynamic workflow.'
    : 'Do not infer a dynamic workflow from an "ultracode" keyword alone; require an explicit workflow request.'
  const size =
    settings.workflowSizeGuideline === 'unrestricted'
      ? 'No workflow size guideline is configured.'
      : `Prefer a ${settings.workflowSizeGuideline} workflow when creating a dynamic workflow unless the user explicitly asks otherwise.`
  return `Dynamic workflows are available for explicitly requested multi-step automation. ${keyword} ${size}`
}

export function externalEditorInitialContent(
  prompt: string,
  history: readonly TranscriptItem[],
  enabled: boolean,
): string {
  if (!enabled) return prompt
  const response = [...history]
    .reverse()
    .find(
      (item): item is TranscriptItem & { kind: 'assistant'; text: string } =>
        item.kind === 'assistant',
    )
  if (!response?.text) return prompt
  return `${prompt}\n\n--- Last response (context only; remove before sending) ---\n${response.text}`
}

export function sessionRecap(
  history: readonly TranscriptItem[],
): string | undefined {
  const lastUser = [...history]
    .reverse()
    .find(
      (item): item is TranscriptItem & { kind: 'user'; text: string } =>
        item.kind === 'user',
    )
  const lastAssistant = [...history]
    .reverse()
    .find(
      (item): item is TranscriptItem & { kind: 'assistant'; text: string } =>
        item.kind === 'assistant',
    )
  if (!lastUser && !lastAssistant) return undefined
  const compact = (text: string) =>
    text.replace(/\s+/gu, ' ').trim().slice(0, 160)
  return [
    'Session recap',
    ...(lastUser ? [`Last request: ${compact(lastUser.text)}`] : []),
    ...(lastAssistant ? [`Last response: ${compact(lastAssistant.text)}`] : []),
  ].join(' · ')
}

export function formatTurnDuration(
  milliseconds: number | undefined,
): string | undefined {
  if (milliseconds === undefined || milliseconds < 0) return undefined
  if (milliseconds < 1_000) return `${milliseconds}ms`
  const seconds = Math.floor(milliseconds / 1_000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function autoUpdateTarget(
  channel: PraxisRuntimeSettings['autoUpdatesChannel'],
): 'latest' | 'stable' {
  return channel === 'stable' ? 'stable' : 'latest'
}
