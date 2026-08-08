export type ClaudeWriteMode = 'read-only' | 'read-write'

export type ClaudeTranscriptEntry = Record<string, unknown> & { type: string }

export interface ClaudeSchemaAdapter {
  readonly version: string
  readonly writeMode: ClaudeWriteMode
  parse(line: string): ClaudeTranscriptEntry
  serialize(entry: ClaudeTranscriptEntry): string
  serializeForAppend(entry: ClaudeTranscriptEntry): string
  serializeForSidechainAppend(entry: ClaudeTranscriptEntry): string
  serializeForFork(entry: ClaudeTranscriptEntry): string
}

const SUPPORTED_VERSION = '2.1.208'
const APPENDABLE_ENTRY_TYPES = new Set([
  'agent-name',
  'agent-setting',
  'assistant',
  'attachment',
  'custom-title',
  'file-history-delta',
  'file-history-snapshot',
  'last-prompt',
  'pr-link',
  'system',
  'user',
  'worktree-state',
])
const FORKABLE_ENTRY_TYPES = new Set([
  'agent-name',
  'agent-setting',
  'ai-title',
  'assistant',
  'attachment',
  'custom-title',
  'last-prompt',
  'mode',
  'permission-mode',
  'pr-link',
  'system',
  'user',
])

export function isClaudeForkableEntryType(type: string): boolean {
  return FORKABLE_ENTRY_TYPES.has(type)
}
const FORKABLE_SYSTEM_SUBTYPES = new Set([
  'api_error',
  'away_summary',
  'compact_boundary',
  'local_command',
  'stop_hook_summary',
  'turn_duration',
])
const FORKABLE_ATTACHMENT_TYPES = new Set([
  'agent_listing_delta',
  'command_permissions',
  'date_change',
  'directory',
  'edited_text_file',
  'file',
  'goal_status',
  'hook_additional_context',
  'hook_blocking_error',
  'hook_error',
  'hook_success',
  'mcp_instructions_delta',
  'nested_memory',
  'plan_mode_exit',
  'queued_command',
  'read_truncation_notice',
  'skill_listing',
  'task_reminder',
])
const RAW_CLAUDE_ENTRY = Symbol('raw-claude-entry')

type RawClaudeEntry = ClaudeTranscriptEntry & {
  [RAW_CLAUDE_ENTRY]?: string
}

function parseEntry(line: string): ClaudeTranscriptEntry {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error) {
    throw new Error('Invalid Claude transcript JSON', { cause: error })
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Claude transcript entry must be an object')
  }

  const entry = value as Record<string, unknown>
  if (typeof entry.type !== 'string' || entry.type.length === 0) {
    throw new Error('Claude transcript entry must have a type')
  }

  Object.defineProperty(entry, RAW_CLAUDE_ENTRY, { value: line })
  return entry as ClaudeTranscriptEntry
}

function serializeEntry(entry: ClaudeTranscriptEntry): string {
  return (entry as RawClaudeEntry)[RAW_CLAUDE_ENTRY] ?? JSON.stringify(entry)
}

function skipWhitespace(source: string, start: number): number {
  let index = start
  while (/\s/u.test(source[index] ?? '')) index += 1
  return index
}

function findStringEnd(source: string, start: number): number {
  if (source[start] !== '"') throw new Error('Expected JSON string')
  let escaped = false
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '"') return index + 1
  }
  throw new Error('Unterminated JSON string')
}

function findValueEnd(source: string, start: number): number {
  if (source[start] === '"') return findStringEnd(source, start)
  if (source[start] !== '{' && source[start] !== '[') {
    let index = start
    while (
      index < source.length &&
      source[index] !== ',' &&
      source[index] !== '}'
    ) {
      index += 1
    }
    return index
  }

  const stack = [source[start]]
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]
    if (character === '"') {
      index = findStringEnd(source, index) - 1
      continue
    }
    if (character === '{' || character === '[') stack.push(character)
    else if (character === '}' || character === ']') {
      const opener = stack.pop()
      if (
        (opener === '{' && character !== '}') ||
        (opener === '[' && character !== ']')
      ) {
        throw new Error('Mismatched JSON container')
      }
      if (stack.length === 0) return index + 1
    }
  }
  throw new Error('Unterminated JSON value')
}

function replaceRootStringProperty(
  source: string,
  property: string,
  value: string,
): string {
  let index = skipWhitespace(source, 0)
  if (source[index] !== '{') throw new Error('Claude entry must be an object')
  index += 1
  let match: { start: number; end: number } | undefined

  while (true) {
    index = skipWhitespace(source, index)
    if (source[index] === '}') break
    const keyStart = index
    const keyEnd = findStringEnd(source, keyStart)
    const key = JSON.parse(source.slice(keyStart, keyEnd)) as unknown
    index = skipWhitespace(source, keyEnd)
    if (source[index] !== ':') throw new Error('Invalid Claude entry property')
    index = skipWhitespace(source, index + 1)
    const valueStart = index
    const valueEnd = findValueEnd(source, valueStart)
    if (key === property) {
      if (match) throw new Error(`Claude entry has duplicate ${property}`)
      if (source[valueStart] !== '"') {
        throw new Error(`Claude entry ${property} must be a string`)
      }
      match = { start: valueStart, end: valueEnd }
    }
    index = skipWhitespace(source, valueEnd)
    if (source[index] === '}') break
    if (source[index] !== ',') throw new Error('Invalid Claude entry object')
    index += 1
  }

  if (!match) throw new Error(`Claude entry is missing ${property}`)
  return `${source.slice(0, match.start)}${JSON.stringify(value)}${source.slice(match.end)}`
}

export function copyClaudeEntryWithSessionId(
  entry: ClaudeTranscriptEntry,
  sessionId: string,
): ClaudeTranscriptEntry {
  const copy = { ...entry, sessionId }
  const raw = (entry as RawClaudeEntry)[RAW_CLAUDE_ENTRY]
  if (raw !== undefined) {
    Object.defineProperty(copy, RAW_CLAUDE_ENTRY, { value: raw })
  }
  return copy
}

function serializeForkEntry(entry: ClaudeTranscriptEntry): string {
  const raw = (entry as RawClaudeEntry)[RAW_CLAUDE_ENTRY]
  return raw === undefined
    ? JSON.stringify(entry)
    : replaceRootStringProperty(raw, 'sessionId', String(entry.sessionId))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function validateMediaSource(value: unknown): void {
  if (
    !isRecord(value) ||
    value.type !== 'base64' ||
    !isNonEmptyString(value.media_type) ||
    typeof value.data !== 'string'
  ) {
    throw new Error('Claude transcript has invalid media source')
  }
}

function validateForkUserContent(content: unknown): void {
  if (typeof content === 'string') return
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('Claude transcript user message has invalid content')
  }
  for (const block of content) {
    if (!isRecord(block)) {
      throw new Error('Claude transcript has invalid user content block')
    }
    if (block.type === 'text' && typeof block.text === 'string') continue
    if (block.type === 'image' || block.type === 'document') {
      validateMediaSource(block.source)
      continue
    }
    if (
      block.type !== 'tool_result' ||
      !isNonEmptyString(block.tool_use_id) ||
      (block.is_error !== undefined && typeof block.is_error !== 'boolean')
    ) {
      throw new Error('Claude transcript has invalid user content block')
    }
    if (typeof block.content === 'string') continue
    if (!Array.isArray(block.content) || block.content.length === 0) {
      throw new Error('Claude transcript has invalid tool result content')
    }
    for (const nested of block.content) {
      if (!isRecord(nested)) {
        throw new Error('Claude transcript has invalid tool result content')
      }
      if (nested.type === 'text' && typeof nested.text === 'string') continue
      if (nested.type === 'image') {
        validateMediaSource(nested.source)
        continue
      }
      throw new Error('Claude transcript has invalid tool result content')
    }
  }
}

function validateForkAssistantMessage(message: Record<string, unknown>): void {
  if (
    message.type !== 'message' ||
    !isNonEmptyString(message.id) ||
    !isNonEmptyString(message.model) ||
    !Array.isArray(message.content) ||
    message.content.length === 0
  ) {
    throw new Error('Claude transcript has invalid assistant message')
  }
  for (const block of message.content) {
    if (!isRecord(block)) {
      throw new Error('Claude transcript has invalid assistant content block')
    }
    if (block.type === 'text' && typeof block.text === 'string') continue
    if (block.type === 'image' || block.type === 'document') {
      validateMediaSource(block.source)
      continue
    }
    if (
      block.type === 'thinking' &&
      typeof block.thinking === 'string' &&
      typeof block.signature === 'string'
    ) {
      continue
    }
    if (
      block.type === 'tool_use' &&
      isNonEmptyString(block.id) &&
      isNonEmptyString(block.name) &&
      isRecord(block.input)
    ) {
      continue
    }
    throw new Error('Claude transcript has invalid assistant content block')
  }
}

function validateUserContent(content: unknown): void {
  if (typeof content === 'string') return
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('Claude transcript user message has invalid content')
  }

  for (const block of content) {
    if (!isRecord(block)) {
      throw new Error('Claude transcript has invalid user content block')
    }
    if (block.type === 'text' && typeof block.text === 'string') continue
    if (block.type === 'image' || block.type === 'document') {
      validateMediaSource(block.source)
      continue
    }
    if (
      block.type !== 'tool_result' ||
      !isNonEmptyString(block.tool_use_id) ||
      (block.is_error !== undefined && typeof block.is_error !== 'boolean')
    ) {
      throw new Error('Claude transcript has invalid user content block')
    }
    if (typeof block.content === 'string') continue
    if (!Array.isArray(block.content) || block.content.length === 0) {
      throw new Error('Claude transcript has invalid tool result content')
    }
    if (
      block.content.length !== 1 ||
      !isRecord(block.content[0]) ||
      block.content[0].type !== 'image'
    ) {
      throw new Error('Claude transcript has invalid tool result content')
    }
    validateMediaSource(block.content[0].source)
  }
}

function validateAssistantMessage(message: Record<string, unknown>): void {
  if (
    message.type !== 'message' ||
    !isNonEmptyString(message.id) ||
    !isNonEmptyString(message.model) ||
    !Array.isArray(message.content) ||
    message.content.length === 0
  ) {
    throw new Error('Claude transcript has invalid assistant message')
  }

  for (const block of message.content) {
    if (!isRecord(block)) {
      throw new Error('Claude transcript has invalid assistant content block')
    }
    if (block.type === 'text' && typeof block.text === 'string') continue
    if (block.type === 'tool_use') {
      if (
        !isNonEmptyString(block.id) ||
        !isNonEmptyString(block.name) ||
        !isRecord(block.input)
      ) {
        throw new Error(
          'Claude transcript has invalid assistant tool_use block',
        )
      }
      continue
    }
    throw new Error('Claude transcript has invalid assistant content block')
  }
}

const APPENDABLE_IMAGE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

function decodedBase64Size(data: string): number | null {
  if (
    data.length === 0 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  ) {
    return null
  }
  const decoded = Buffer.from(data, 'base64')
  return decoded.toString('base64') === data ? decoded.length : null
}

function validateImageToolResultMetadata(
  entry: ClaudeTranscriptEntry,
  message: Record<string, unknown>,
): void {
  const hasImageMetadata =
    isRecord(entry.toolUseResult) && entry.toolUseResult.type === 'image'
  if (!Array.isArray(message.content)) {
    if (hasImageMetadata) {
      throw new Error('Claude image tool result metadata is invalid')
    }
    return
  }
  const toolResults = message.content.filter(
    (block): block is Record<string, unknown> =>
      isRecord(block) && block.type === 'tool_result',
  )
  const images = toolResults.flatMap((toolResult) =>
    Array.isArray(toolResult.content)
      ? toolResult.content.filter(
          (block): block is Record<string, unknown> =>
            isRecord(block) && block.type === 'image',
        )
      : [],
  )
  if (images.length === 0 && !hasImageMetadata) return
  const toolResult = toolResults.find(
    (block) =>
      Array.isArray(block.content) &&
      block.content.some(
        (nested) => isRecord(nested) && nested.type === 'image',
      ),
  )
  const image = images[0]
  if (
    entry.type !== 'user' ||
    message.content.length !== 1 ||
    toolResults.length !== 1 ||
    images.length !== 1 ||
    !toolResult ||
    toolResult.is_error !== undefined ||
    !Array.isArray(toolResult.content) ||
    toolResult.content.length !== 1 ||
    !image ||
    !isRecord(image.source) ||
    image.source.type !== 'base64' ||
    !isNonEmptyString(image.source.media_type) ||
    !APPENDABLE_IMAGE_MEDIA_TYPES.has(image.source.media_type) ||
    !isNonEmptyString(image.source.data) ||
    !isRecord(entry.toolUseResult) ||
    entry.toolUseResult.type !== 'image' ||
    !isRecord(entry.toolUseResult.file)
  ) {
    throw new Error('Claude image tool result metadata is invalid')
  }
  const file = entry.toolUseResult.file
  const decodedSize = decodedBase64Size(image.source.data)
  if (
    file.base64 !== image.source.data ||
    file.type !== image.source.media_type ||
    !Number.isSafeInteger(file.originalSize) ||
    typeof file.originalSize !== 'number' ||
    file.originalSize < 0 ||
    decodedSize === null ||
    file.originalSize !== decodedSize
  ) {
    throw new Error('Claude image tool result metadata is invalid')
  }
}

function validateNestedMemoryAttachment(entry: ClaudeTranscriptEntry): void {
  if (
    entry.isSidechain !== false ||
    entry.userType !== 'external' ||
    entry.entrypoint !== 'cli' ||
    !('gitBranch' in entry) ||
    (entry.gitBranch !== null && typeof entry.gitBranch !== 'string') ||
    !isRecord(entry.attachment)
  ) {
    throw new Error('Claude transcript has invalid nested-memory attachment')
  }
  const attachment = entry.attachment
  if (
    attachment.type !== 'nested_memory' ||
    !isNonEmptyString(attachment.path) ||
    !isNonEmptyString(attachment.displayPath) ||
    !isRecord(attachment.content)
  ) {
    throw new Error('Claude transcript has invalid nested-memory attachment')
  }
  const content = attachment.content
  if (
    content.path !== attachment.path ||
    (content.type !== 'Project' && content.type !== 'User') ||
    typeof content.content !== 'string' ||
    typeof content.rawContent !== 'string' ||
    typeof content.contentDiffersFromDisk !== 'boolean' ||
    !Array.isArray(content.globs) ||
    content.globs.length === 0 ||
    content.globs.some((glob) => !isNonEmptyString(glob))
  ) {
    throw new Error('Claude transcript has invalid nested-memory attachment')
  }
}

function validateHookAttachment(
  entry: ClaudeTranscriptEntry,
  allowNativeEntrypoint = false,
): void {
  const validChain =
    entry.isSidechain === false ||
    (entry.isSidechain === true && isNonEmptyString(entry.agentId))
  if (
    !validChain ||
    entry.userType !== 'external' ||
    (entry.entrypoint !== 'cli' &&
      (!allowNativeEntrypoint ||
        (entry.entrypoint !== 'sdk-cli' && entry.entrypoint !== 'sdk-ts'))) ||
    !('gitBranch' in entry) ||
    (entry.gitBranch !== null && typeof entry.gitBranch !== 'string') ||
    !isRecord(entry.attachment)
  ) {
    throw new Error('Claude transcript has invalid hook attachment')
  }
  const attachment = entry.attachment
  if (
    !isNonEmptyString(attachment.hookName) ||
    !isNonEmptyString(attachment.toolUseID) ||
    !isNonEmptyString(attachment.hookEvent)
  ) {
    throw new Error('Claude transcript has invalid hook attachment metadata')
  }
  if (attachment.type === 'hook_additional_context') {
    if (
      !Array.isArray(attachment.content) ||
      attachment.content.length === 0 ||
      attachment.content.some((value) => !isNonEmptyString(value))
    ) {
      throw new Error('Claude transcript has invalid hook context attachment')
    }
    return
  }
  if (
    (attachment.type !== 'hook_success' && attachment.type !== 'hook_error') ||
    typeof attachment.content !== 'string' ||
    typeof attachment.stdout !== 'string' ||
    typeof attachment.stderr !== 'string' ||
    !Number.isInteger(attachment.exitCode) ||
    !isNonEmptyString(attachment.command) ||
    typeof attachment.durationMs !== 'number' ||
    attachment.durationMs < 0
  ) {
    throw new Error('Claude transcript has invalid hook success attachment')
  }
}

function validateAttachment(
  entry: ClaudeTranscriptEntry,
  allowNativeEntrypoint = false,
): void {
  if (!isRecord(entry.attachment)) {
    throw new Error('Claude transcript has invalid attachment')
  }
  if (entry.attachment.type === 'nested_memory') {
    validateNestedMemoryAttachment(entry)
    return
  }
  if (
    entry.attachment.type === 'hook_success' ||
    entry.attachment.type === 'hook_error' ||
    entry.attachment.type === 'hook_additional_context'
  ) {
    validateHookAttachment(entry, allowNativeEntrypoint)
    return
  }
  throw new Error('Claude transcript has unsupported attachment type')
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function validateCompactBoundary(entry: ClaudeTranscriptEntry): void {
  const metadata = entry.compactMetadata
  if (
    entry.subtype !== 'compact_boundary' ||
    entry.content !== 'Conversation compacted' ||
    entry.parentUuid !== null ||
    entry.isSidechain !== false ||
    entry.isMeta !== false ||
    entry.level !== 'info' ||
    entry.userType !== 'external' ||
    (entry.entrypoint !== 'cli' && entry.entrypoint !== 'sdk-cli') ||
    !('gitBranch' in entry) ||
    (entry.gitBranch !== null && typeof entry.gitBranch !== 'string') ||
    !isNonEmptyString(entry.logicalParentUuid) ||
    !isRecord(metadata)
  ) {
    throw new Error('Claude transcript has invalid compact boundary')
  }
  const segment = metadata.preservedSegment
  const messages = metadata.preservedMessages
  if (
    (metadata.trigger !== 'auto' && metadata.trigger !== 'manual') ||
    !isNonNegativeNumber(metadata.preTokens) ||
    !isNonNegativeNumber(metadata.postTokens) ||
    !isNonNegativeNumber(metadata.durationMs) ||
    !isNonNegativeNumber(metadata.cumulativeDroppedTokens) ||
    !isRecord(segment) ||
    segment.headUuid !== entry.logicalParentUuid ||
    segment.tailUuid !== entry.logicalParentUuid ||
    !isNonEmptyString(segment.anchorUuid) ||
    !isRecord(messages) ||
    messages.anchorUuid !== segment.anchorUuid ||
    !Array.isArray(messages.uuids) ||
    messages.uuids.length === 0 ||
    messages.uuids.some((value) => !isNonEmptyString(value)) ||
    !Array.isArray(messages.allUuids) ||
    messages.allUuids.length === 0 ||
    messages.allUuids.some((value) => !isNonEmptyString(value))
  ) {
    throw new Error('Claude transcript has invalid compact metadata')
  }
}

function validateCompactSummary(entry: ClaudeTranscriptEntry): void {
  if (
    entry.type !== 'user' ||
    entry.isCompactSummary !== true ||
    entry.isVisibleInTranscriptOnly !== true ||
    entry.isSidechain !== false ||
    entry.userType !== 'external' ||
    (entry.entrypoint !== 'cli' && entry.entrypoint !== 'sdk-cli') ||
    !('gitBranch' in entry) ||
    (entry.gitBranch !== null && typeof entry.gitBranch !== 'string') ||
    !isNonEmptyString(entry.promptId) ||
    !isRecord(entry.message) ||
    entry.message.role !== 'user' ||
    !isNonEmptyString(entry.message.content)
  ) {
    throw new Error('Claude transcript has invalid compact summary')
  }
}

function validateAppendableEntry(entry: ClaudeTranscriptEntry): void {
  if (entry.type === 'file-history-snapshot') {
    if (
      !isNonEmptyString(entry.messageId) ||
      entry.isSnapshotUpdate !== false ||
      !isRecord(entry.snapshot) ||
      entry.snapshot.messageId !== entry.messageId ||
      !isNonEmptyString(entry.snapshot.timestamp) ||
      !isRecord(entry.snapshot.trackedFileBackups)
    ) {
      throw new Error('Claude file-history snapshot is invalid')
    }
    return
  }
  if (entry.type === 'file-history-delta') {
    if (
      !isNonEmptyString(entry.messageId) ||
      !isNonEmptyString(entry.snapshotMessageId) ||
      !isNonEmptyString(entry.trackingPath) ||
      !isRecord(entry.backup) ||
      !isNonEmptyString(entry.timestamp)
    ) {
      throw new Error('Claude file-history delta is invalid')
    }
    return
  }
  if (entry.type === 'worktree-state') {
    if (!isNonEmptyString(entry.sessionId)) {
      throw new Error('Claude worktree-state entry has invalid sessionId')
    }
    if (entry.worktreeSession === null) return
    if (!isRecord(entry.worktreeSession)) {
      throw new Error('Claude worktree-state entry has invalid state')
    }
    for (const field of [
      'originalCwd',
      'preEnterOriginalCwd',
      'worktreePath',
      'worktreeName',
      'originalHeadCommit',
      'sessionId',
    ]) {
      if (!isNonEmptyString(entry.worktreeSession[field])) {
        throw new Error(`Claude worktree-state is missing ${field}`)
      }
    }
    for (const field of ['worktreeBranch', 'originalBranch']) {
      const value = entry.worktreeSession[field]
      if (value !== null && !isNonEmptyString(value)) {
        throw new Error(`Claude worktree-state has invalid ${field}`)
      }
    }
    return
  }
  if (entry.type === 'custom-title') {
    if (
      !isNonEmptyString(entry.customTitle) ||
      !isNonEmptyString(entry.sessionId)
    ) {
      throw new Error('Claude custom-title entry has invalid metadata')
    }
    return
  }
  if (entry.type === 'agent-name') {
    if (
      !isNonEmptyString(entry.agentName) ||
      !isNonEmptyString(entry.sessionId)
    ) {
      throw new Error('Claude agent-name entry has invalid metadata')
    }
    return
  }
  if (entry.type === 'agent-setting') {
    if (
      !isNonEmptyString(entry.agentSetting) ||
      !isNonEmptyString(entry.sessionId)
    ) {
      throw new Error('Claude agent-setting entry has invalid metadata')
    }
    return
  }
  if (entry.type === 'last-prompt') {
    if (!isNonEmptyString(entry.leafUuid)) {
      throw new Error('Claude last-prompt entry has invalid leafUuid')
    }
    if (
      !isNonEmptyString(entry.sessionId) ||
      !isNonEmptyString(entry.lastPrompt)
    ) {
      throw new Error('Claude last-prompt entry has invalid metadata')
    }
    return
  }
  if (entry.type === 'pr-link') {
    if (
      !isNonEmptyString(entry.sessionId) ||
      typeof entry.prNumber !== 'number' ||
      !Number.isSafeInteger(entry.prNumber) ||
      entry.prNumber < 1 ||
      !isNonEmptyString(entry.prUrl) ||
      !isNonEmptyString(entry.prRepository) ||
      !isNonEmptyString(entry.timestamp)
    ) {
      throw new Error('Claude pr-link entry has invalid metadata')
    }
    return
  }

  for (const field of ['uuid', 'sessionId', 'timestamp', 'cwd', 'version']) {
    if (typeof entry[field] !== 'string' || entry[field].length === 0) {
      throw new Error(`Claude transcript entry is missing ${field}`)
    }
  }

  if (entry.version !== SUPPORTED_VERSION) {
    throw new Error(
      `Claude transcript append must target Claude Code ${SUPPORTED_VERSION}`,
    )
  }

  if (
    !('parentUuid' in entry) ||
    (entry.parentUuid !== null && !isNonEmptyString(entry.parentUuid))
  ) {
    throw new Error('Claude transcript entry has invalid parentUuid')
  }
  if (entry.type === 'system') {
    validateCompactBoundary(entry)
    return
  }
  if (entry.isCompactSummary === true) {
    validateCompactSummary(entry)
    return
  }
  if (entry.isSidechain === true) {
    throw new Error('Praxis cannot append Claude sidechains yet')
  }
  if (entry.toolDenialKind !== undefined) {
    throw new Error('Praxis cannot append Claude tool denials yet')
  }

  if (entry.type === 'attachment') {
    validateAttachment(entry)
    return
  }

  if (!isRecord(entry.message)) {
    throw new Error('Claude transcript entry is missing message')
  }

  const role = entry.message.role
  if (role !== entry.type) {
    throw new Error('Claude transcript message role does not match entry type')
  }
  validateImageToolResultMetadata(entry, entry.message)

  if (entry.type === 'user') {
    validateUserContent(entry.message.content)
  } else {
    validateAssistantMessage(entry.message)
  }
}

function validateSidechainEntry(entry: ClaudeTranscriptEntry): void {
  for (const field of [
    'uuid',
    'sessionId',
    'timestamp',
    'cwd',
    'version',
    'agentId',
  ]) {
    if (!isNonEmptyString(entry[field])) {
      throw new Error(`Claude sidechain entry is missing ${field}`)
    }
  }
  if (entry.version !== SUPPORTED_VERSION) {
    throw new Error(
      `Claude sidechain append must target Claude Code ${SUPPORTED_VERSION}`,
    )
  }
  if (
    !('parentUuid' in entry) ||
    (entry.parentUuid !== null && !isNonEmptyString(entry.parentUuid))
  ) {
    throw new Error('Claude sidechain entry has invalid parentUuid')
  }
  if (
    entry.isSidechain !== true ||
    entry.userType !== 'external' ||
    entry.entrypoint !== 'cli' ||
    !('gitBranch' in entry) ||
    (entry.gitBranch !== null && typeof entry.gitBranch !== 'string')
  ) {
    throw new Error('Claude sidechain entry has invalid metadata')
  }
  if (entry.toolDenialKind !== undefined || entry.isCompactSummary === true) {
    throw new Error('Claude sidechain entry has unsupported runtime metadata')
  }
  if (entry.type === 'attachment') {
    validateAttachment(entry)
    return
  }
  if (entry.type !== 'user' && entry.type !== 'assistant') {
    throw new Error(`Claude sidechain entry type ${entry.type} is unsupported`)
  }
  if (!isRecord(entry.message) || entry.message.role !== entry.type) {
    throw new Error('Claude sidechain entry has invalid message role')
  }
  validateImageToolResultMetadata(entry, entry.message)
  if (entry.type === 'user') {
    if (!isNonEmptyString(entry.promptId)) {
      throw new Error('Claude sidechain user entry is missing promptId')
    }
    validateUserContent(entry.message.content)
  } else {
    if (!isNonEmptyString(entry.attributionAgent)) {
      throw new Error('Claude sidechain assistant is missing attributionAgent')
    }
    validateAssistantMessage(entry.message)
  }
}

function validateForkableEntry(entry: ClaudeTranscriptEntry): void {
  if (entry.type === 'custom-title' || entry.type === 'agent-name') {
    validateAppendableEntry(entry)
    return
  }
  if (entry.type === 'ai-title') {
    if (
      !isNonEmptyString(entry.aiTitle) ||
      !isNonEmptyString(entry.sessionId)
    ) {
      throw new Error('Claude ai-title entry has invalid metadata')
    }
    return
  }
  if (entry.type === 'agent-setting') {
    validateAppendableEntry(entry)
    return
  }
  if (entry.type === 'last-prompt') {
    if (
      !isNonEmptyString(entry.sessionId) ||
      !isNonEmptyString(entry.leafUuid) ||
      (entry.lastPrompt !== undefined && !isNonEmptyString(entry.lastPrompt))
    ) {
      throw new Error('Claude last-prompt entry has invalid metadata')
    }
    return
  }
  if (entry.type === 'mode') {
    if (!isNonEmptyString(entry.mode) || !isNonEmptyString(entry.sessionId)) {
      throw new Error('Claude mode entry has invalid metadata')
    }
    return
  }
  if (entry.type === 'permission-mode') {
    if (
      !isNonEmptyString(entry.permissionMode) ||
      !isNonEmptyString(entry.sessionId)
    ) {
      throw new Error('Claude permission-mode entry has invalid metadata')
    }
    return
  }
  if (entry.type === 'pr-link') {
    validateAppendableEntry(entry)
    return
  }

  for (const field of ['uuid', 'sessionId', 'timestamp', 'cwd', 'version']) {
    if (!isNonEmptyString(entry[field])) {
      throw new Error(`Claude transcript entry is missing ${field}`)
    }
  }
  if (entry.version !== SUPPORTED_VERSION) {
    throw new Error(
      `Claude transcript fork must target Claude Code ${SUPPORTED_VERSION}`,
    )
  }
  if (
    !('parentUuid' in entry) ||
    (entry.parentUuid !== null && !isNonEmptyString(entry.parentUuid))
  ) {
    throw new Error('Claude transcript entry has invalid parentUuid')
  }
  if (entry.isSidechain !== false) {
    throw new Error('Claude fork entry must belong to the main chain')
  }
  if (entry.type === 'system') {
    if (!FORKABLE_SYSTEM_SUBTYPES.has(String(entry.subtype))) {
      throw new Error('Claude system entry has unsupported subtype')
    }
    if (entry.subtype === 'compact_boundary') validateCompactBoundary(entry)
    return
  }
  if (entry.isCompactSummary === true) {
    validateCompactSummary(entry)
    return
  }
  if (entry.type === 'attachment') {
    if (
      !isRecord(entry.attachment) ||
      !FORKABLE_ATTACHMENT_TYPES.has(String(entry.attachment.type))
    ) {
      throw new Error('Claude transcript has unsupported attachment')
    }
    if (
      entry.attachment.type === 'nested_memory' ||
      entry.attachment.type === 'hook_success' ||
      entry.attachment.type === 'hook_error' ||
      entry.attachment.type === 'hook_additional_context'
    ) {
      validateAttachment(entry, true)
    }
    return
  }
  if (!isRecord(entry.message) || entry.message.role !== entry.type) {
    throw new Error('Claude fork entry has invalid message role')
  }
  if (entry.type === 'user') validateForkUserContent(entry.message.content)
  else validateForkAssistantMessage(entry.message)
}

class ClaudeCode21208Adapter implements ClaudeSchemaAdapter {
  readonly version = SUPPORTED_VERSION
  readonly writeMode = 'read-write' as const

  parse(line: string): ClaudeTranscriptEntry {
    return parseEntry(line)
  }

  serialize(entry: ClaudeTranscriptEntry): string {
    return serializeEntry(entry)
  }

  serializeForAppend(entry: ClaudeTranscriptEntry): string {
    if (!APPENDABLE_ENTRY_TYPES.has(entry.type)) {
      throw new Error(
        `Claude transcript entry type ${entry.type} is not appendable by Praxis`,
      )
    }

    validateAppendableEntry(entry)

    return serializeEntry(entry)
  }

  serializeForSidechainAppend(entry: ClaudeTranscriptEntry): string {
    validateSidechainEntry(entry)
    return serializeEntry(entry)
  }

  serializeForFork(entry: ClaudeTranscriptEntry): string {
    if (!isClaudeForkableEntryType(entry.type)) {
      throw new Error(
        `Claude transcript entry type ${entry.type} is not forkable by Praxis`,
      )
    }
    validateForkableEntry(entry)
    return serializeForkEntry(entry)
  }
}

class ReadOnlyClaudeAdapter implements ClaudeSchemaAdapter {
  readonly writeMode = 'read-only' as const

  constructor(readonly version: string) {}

  parse(line: string): ClaudeTranscriptEntry {
    return parseEntry(line)
  }

  serialize(entry: ClaudeTranscriptEntry): string {
    return serializeEntry(entry)
  }

  serializeForAppend(): never {
    throw new Error(
      `Unsupported Claude Code transcript version ${this.version}; read-only mode`,
    )
  }

  serializeForSidechainAppend(): never {
    throw new Error(
      `Unsupported Claude Code transcript version ${this.version}; read-only mode`,
    )
  }

  serializeForFork(): never {
    throw new Error(
      `Unsupported Claude Code transcript version ${this.version}; read-only mode`,
    )
  }
}

export function selectClaudeSchemaAdapter(
  version: string,
): ClaudeSchemaAdapter {
  if (version === SUPPORTED_VERSION) {
    return new ClaudeCode21208Adapter()
  }

  return new ReadOnlyClaudeAdapter(version)
}

export function parseClaudeVersionOutput(output: string): string {
  const match = /^(\d+\.\d+\.\d+)\s+\(Claude Code\)\s*$/.exec(output)
  if (!match?.[1]) {
    throw new Error('Unable to detect Claude Code version')
  }

  return match[1]
}
