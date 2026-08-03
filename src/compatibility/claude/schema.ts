export type ClaudeWriteMode = 'read-only' | 'read-write'

export type ClaudeTranscriptEntry = Record<string, unknown> & { type: string }

export interface ClaudeSchemaAdapter {
  readonly version: string
  readonly writeMode: ClaudeWriteMode
  parse(line: string): ClaudeTranscriptEntry
  serialize(entry: ClaudeTranscriptEntry): string
  serializeForAppend(entry: ClaudeTranscriptEntry): string
  serializeForFork(entry: ClaudeTranscriptEntry): string
}

const SUPPORTED_VERSION = '2.1.208'
const APPENDABLE_ENTRY_TYPES = new Set([
  'agent-setting',
  'assistant',
  'attachment',
  'last-prompt',
  'user',
])
const FORKABLE_ENTRY_TYPES = new Set(['assistant', 'last-prompt', 'user'])

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

  return entry as ClaudeTranscriptEntry
}

function serializeEntry(entry: ClaudeTranscriptEntry): string {
  return JSON.stringify(entry)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
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
    if (
      block.type === 'tool_result' &&
      isNonEmptyString(block.tool_use_id) &&
      typeof block.content === 'string' &&
      (block.is_error === undefined || typeof block.is_error === 'boolean')
    ) {
      continue
    }
    throw new Error('Claude transcript has invalid user content block')
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

function hasImageContent(message: Record<string, unknown>): boolean {
  if (!Array.isArray(message.content)) return false
  return message.content.some((value) => {
    if (!isRecord(value)) return false
    if (value.type === 'image') return true
    return (
      value.type === 'tool_result' &&
      Array.isArray(value.content) &&
      value.content.some(
        (nestedValue) => isRecord(nestedValue) && nestedValue.type === 'image',
      )
    )
  })
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

function validateAppendableEntry(entry: ClaudeTranscriptEntry): void {
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
    (entry.parentUuid !== null && typeof entry.parentUuid !== 'string')
  ) {
    throw new Error('Claude transcript entry has invalid parentUuid')
  }
  if (entry.isCompactSummary === true) {
    throw new Error('Praxis cannot append Claude compact summaries yet')
  }
  if (entry.isSidechain === true) {
    throw new Error('Praxis cannot append Claude sidechains yet')
  }
  if (entry.toolDenialKind !== undefined) {
    throw new Error('Praxis cannot append Claude tool denials yet')
  }

  if (entry.type === 'attachment') {
    validateNestedMemoryAttachment(entry)
    return
  }

  if (!isRecord(entry.message)) {
    throw new Error('Claude transcript entry is missing message')
  }

  const role = entry.message.role
  if (role !== entry.type) {
    throw new Error('Claude transcript message role does not match entry type')
  }
  if (hasImageContent(entry.message)) {
    throw new Error('Praxis cannot append Claude image results yet')
  }

  if (entry.type === 'user') {
    validateUserContent(entry.message.content)
  } else {
    validateAssistantMessage(entry.message)
  }
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

  serializeForFork(entry: ClaudeTranscriptEntry): string {
    if (!FORKABLE_ENTRY_TYPES.has(entry.type)) {
      throw new Error(
        `Claude transcript entry type ${entry.type} is not forkable by Praxis`,
      )
    }
    validateAppendableEntry(entry)
    return serializeEntry(entry)
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
