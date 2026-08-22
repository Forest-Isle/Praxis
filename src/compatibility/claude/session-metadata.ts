import type { ClaudeTranscriptEntry } from './schema.js'

export interface ClaudeSessionPrLink {
  prNumber: number
  prUrl?: string
  prRepository?: string
}

export interface ClaudeSessionMetadata {
  title?: string
  titleSource?: 'custom-title' | 'ai-title'
  customTitle?: string
  aiTitle?: string
  tag?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  permissionMode?: string
  mode?: string
  worktreeSession?: Readonly<Record<string, unknown>>
  prLink?: ClaudeSessionPrLink
  lastPrompt?: string
  lastPromptLeafUuid?: string
}

export const CLAUDE_DURABLE_METADATA_TYPES = [
  'custom-title',
  'ai-title',
  'tag',
  'agent-name',
  'agent-color',
  'agent-setting',
  'permission-mode',
  'mode',
  'worktree-state',
  'pr-link',
  'last-prompt',
] as const

export type ClaudeDurableMetadataType =
  (typeof CLAUDE_DURABLE_METADATA_TYPES)[number]

const DURABLE_METADATA_TYPE_SET = new Set<string>(CLAUDE_DURABLE_METADATA_TYPES)

export function isClaudeDurableMetadataType(
  type: string,
): type is ClaudeDurableMetadataType {
  return DURABLE_METADATA_TYPE_SET.has(type)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

/**
 * Reduces Claude's append-only metadata records. Each metadata type is
 * independently last-wins, while a user-authored custom title always takes
 * precedence over an AI title regardless of append order.
 *
 * Unknown records remain untouched in the transcript but never become
 * authoritative session state here.
 */
export function reduceClaudeSessionMetadata(
  entries: readonly ClaudeTranscriptEntry[],
  sessionId?: string,
): ClaudeSessionMetadata {
  const latest = new Map<ClaudeDurableMetadataType, ClaudeTranscriptEntry>()
  for (const entry of entries) {
    if (!isClaudeDurableMetadataType(entry.type)) continue
    if (
      sessionId !== undefined &&
      typeof entry.sessionId === 'string' &&
      entry.sessionId !== sessionId
    ) {
      continue
    }
    latest.set(entry.type, entry)
  }

  const customTitle = nonEmptyString(latest.get('custom-title')?.customTitle)
  const aiTitle = nonEmptyString(latest.get('ai-title')?.aiTitle)
  const tag = nonEmptyString(latest.get('tag')?.tag)
  const agentName = nonEmptyString(latest.get('agent-name')?.agentName)
  const agentColor = nonEmptyString(latest.get('agent-color')?.agentColor)
  const agentSetting = nonEmptyString(latest.get('agent-setting')?.agentSetting)
  const permissionMode = nonEmptyString(
    latest.get('permission-mode')?.permissionMode,
  )
  const mode = nonEmptyString(latest.get('mode')?.mode)
  const worktreeSession = record(latest.get('worktree-state')?.worktreeSession)
  const pr = latest.get('pr-link')
  const prNumber = pr?.prNumber
  const prUrl = nonEmptyString(pr?.prUrl)
  const prRepository = nonEmptyString(pr?.prRepository)
  const prLink =
    Number.isSafeInteger(prNumber) && Number(prNumber) > 0
      ? {
          prNumber: Number(prNumber),
          ...(prUrl === undefined ? {} : { prUrl }),
          ...(prRepository === undefined ? {} : { prRepository }),
        }
      : undefined
  const lastPromptEntry = latest.get('last-prompt')
  const lastPrompt = nonEmptyString(lastPromptEntry?.lastPrompt)
  const lastPromptLeafUuid = nonEmptyString(lastPromptEntry?.leafUuid)

  return {
    ...(customTitle === undefined ? {} : { customTitle }),
    ...(aiTitle === undefined ? {} : { aiTitle }),
    ...(customTitle !== undefined
      ? { title: customTitle, titleSource: 'custom-title' as const }
      : aiTitle !== undefined
        ? { title: aiTitle, titleSource: 'ai-title' as const }
        : {}),
    ...(tag === undefined ? {} : { tag }),
    ...(agentName === undefined ? {} : { agentName }),
    ...(agentColor === undefined ? {} : { agentColor }),
    ...(agentSetting === undefined ? {} : { agentSetting }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(mode === undefined ? {} : { mode }),
    ...(worktreeSession === undefined ? {} : { worktreeSession }),
    ...(prLink === undefined ? {} : { prLink }),
    ...(lastPrompt === undefined ? {} : { lastPrompt }),
    ...(lastPromptLeafUuid === undefined ? {} : { lastPromptLeafUuid }),
  }
}

/** Returns one current record per durable metadata type for a tail snapshot. */
export function createClaudeDurableMetadataSnapshot(
  entries: readonly ClaudeTranscriptEntry[],
  sessionId: string,
  options: { trustLastPromptReference?: boolean } = {},
): ClaudeTranscriptEntry[] {
  const latest = new Map<ClaudeDurableMetadataType, ClaudeTranscriptEntry>()
  for (const entry of entries) {
    if (!isClaudeDurableMetadataType(entry.type)) continue
    if (typeof entry.sessionId === 'string' && entry.sessionId !== sessionId) {
      continue
    }
    latest.set(entry.type, entry)
  }

  // A later AI title must never obscure a user rename in a bounded tail.
  if (latest.has('custom-title')) latest.delete('ai-title')

  const lastPrompt = latest.get('last-prompt')
  if (lastPrompt !== undefined) {
    const committedLeafUuid = nonEmptyString(lastPrompt.leafUuid)
    const committedLeaf = entries.find(
      (entry) =>
        entry.isSidechain !== true &&
        typeof entry.uuid === 'string' &&
        entry.uuid === committedLeafUuid &&
        (entry.type === 'assistant' ||
          (entry.type === 'system' &&
            entry.subtype === 'local_command' &&
            typeof entry.content === 'string' &&
            entry.content.startsWith('<local-command-stdout>'))),
    )
    const trustedCommittedLeafUuid =
      committedLeaf?.uuid ??
      (options.trustLastPromptReference ? committedLeafUuid : undefined)
    if (trustedCommittedLeafUuid === undefined) {
      latest.delete('last-prompt')
    } else {
      // Metadata-only re-appends never promote a newer assistant: it may be
      // an abandoned or failed branch. A completed local command is itself a
      // committed observable result, so it may safely advance the hint when
      // it descends from the last committed turn.
      const byUuid = new Map(
        entries.flatMap((entry) =>
          entry.isSidechain !== true && typeof entry.uuid === 'string'
            ? [[entry.uuid, entry] as const]
            : [],
        ),
      )
      const localCommandLeaf = [...entries].reverse().find((entry) => {
        if (
          entry.isSidechain === true ||
          entry.type !== 'system' ||
          entry.subtype !== 'local_command' ||
          typeof entry.uuid !== 'string' ||
          typeof entry.content !== 'string' ||
          !entry.content.startsWith('<local-command-stdout>')
        ) {
          return false
        }
        let parentUuid =
          typeof entry.parentUuid === 'string' ? entry.parentUuid : null
        const seen = new Set<string>()
        while (parentUuid !== null && !seen.has(parentUuid)) {
          if (parentUuid === trustedCommittedLeafUuid) return true
          seen.add(parentUuid)
          const parent = byUuid.get(parentUuid)
          if (parent?.type !== 'system' || parent.subtype !== 'local_command') {
            return false
          }
          parentUuid =
            typeof parent?.parentUuid === 'string' ? parent.parentUuid : null
        }
        return false
      })
      if (localCommandLeaf === undefined) {
        latest.set('last-prompt', lastPrompt)
      } else {
        const snapshot: ClaudeTranscriptEntry = {
          ...lastPrompt,
          leafUuid: localCommandLeaf.uuid,
        }
        delete snapshot.lastPrompt
        latest.set('last-prompt', snapshot)
      }
    }
  }

  return CLAUDE_DURABLE_METADATA_TYPES.flatMap((type) => {
    const entry = latest.get(type)
    return entry === undefined ? [] : [{ ...entry, sessionId }]
  })
}

/** Keeps the last known full baseline while overlaying metadata visible in a
 * newer bounded head/tail observation. Structural entries are included only
 * to validate or safely advance the committed last-prompt hint. */
export function mergeClaudeDurableMetadataSnapshot(
  baseline: readonly ClaudeTranscriptEntry[],
  observed: readonly ClaudeTranscriptEntry[],
  sessionId: string,
): ClaudeTranscriptEntry[] {
  return createClaudeDurableMetadataSnapshot(
    [...baseline, ...observed],
    sessionId,
    { trustLastPromptReference: true },
  )
}

export function createClaudeTagEntry(
  sessionId: string,
  tag: string,
): ClaudeTranscriptEntry {
  if (tag.length === 0) throw new Error('Session tag must not be empty')
  return { type: 'tag', tag, sessionId }
}
