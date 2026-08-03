export type ClaudeWriteMode = 'read-only' | 'read-write'

export type ClaudeTranscriptEntry = Record<string, unknown> & { type: string }

export interface ClaudeSchemaAdapter {
  readonly version: string
  readonly writeMode: ClaudeWriteMode
  parse(line: string): ClaudeTranscriptEntry
  serialize(entry: ClaudeTranscriptEntry): string
  serializeForAppend(entry: ClaudeTranscriptEntry): string
}

const SUPPORTED_VERSION = '2.1.208'
const APPENDABLE_ENTRY_TYPES = new Set(['assistant', 'user'])

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

function validateAppendableEntry(entry: ClaudeTranscriptEntry): void {
  for (const field of ['uuid', 'sessionId', 'timestamp', 'cwd', 'version']) {
    if (typeof entry[field] !== 'string' || entry[field].length === 0) {
      throw new Error(`Claude transcript entry is missing ${field}`)
    }
  }

  if (
    !('parentUuid' in entry) ||
    (entry.parentUuid !== null && typeof entry.parentUuid !== 'string')
  ) {
    throw new Error('Claude transcript entry has invalid parentUuid')
  }
  if (
    typeof entry.message !== 'object' ||
    entry.message === null ||
    Array.isArray(entry.message)
  ) {
    throw new Error('Claude transcript entry is missing message')
  }

  const role = (entry.message as Record<string, unknown>).role
  if (role !== entry.type) {
    throw new Error('Claude transcript message role does not match entry type')
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
  if (JSON.stringify(entry.message).includes('"type":"image"')) {
    throw new Error('Praxis cannot append Claude image results yet')
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
