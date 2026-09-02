import type { ModelToolDefinition } from '../core/runtime.js'
import { countLineChanges } from './line-changes.js'

export const APPLY_PATCH_MAX_EDITS = 32
export const APPLY_PATCH_MAX_FILES = 8
export const APPLY_PATCH_MAX_INPUT_BYTES = 256 * 1024

export interface ApplyPatchEdit {
  file_path: string
  old_string: string
  new_string: string
}

export interface ApplyPatchPlanFile {
  filePath: string
  before: string
  after: string
  linesAdded: number
  linesRemoved: number
}

export interface ApplyPatchPlan {
  files: readonly ApplyPatchPlanFile[]
  linesAdded: number
  linesRemoved: number
}

export const APPLY_PATCH_DEFINITION: ModelToolDefinition = {
  name: 'ApplyPatch',
  description:
    'Applies a bounded batch of exact, unique string replacements to existing files.',
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      edits: {
        type: 'array',
        minItems: 1,
        maxItems: APPLY_PATCH_MAX_EDITS,
        items: {
          type: 'object',
          properties: {
            file_path: { type: 'string', minLength: 1 },
            old_string: { type: 'string', minLength: 1 },
            new_string: { type: 'string' },
          },
          required: ['file_path', 'old_string', 'new_string'],
          additionalProperties: false,
        },
      },
    },
    required: ['edits'],
    additionalProperties: false,
  },
}

function objectInput(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error(`${label} must be an object`)
  return input as Record<string, unknown>
}

function exactKeys(input: Record<string, unknown>, keys: readonly string[]) {
  const unexpected = Object.keys(input).find((key) => !keys.includes(key))
  if (unexpected) throw new Error(`Unexpected ApplyPatch field: ${unexpected}`)
}

function stringInput(
  input: Record<string, unknown>,
  key: string,
  nonEmpty = false,
): string {
  const value = input[key]
  if (typeof value !== 'string' || (nonEmpty && value.length === 0))
    throw new Error(`${key} must be ${nonEmpty ? 'a non-empty ' : 'a '}string`)
  return value
}

export function parseApplyPatchInput(input: unknown): ApplyPatchEdit[] {
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(input)
  } catch {
    throw new Error('ApplyPatch input must be JSON-serializable')
  }
  if (encoded === undefined)
    throw new Error('ApplyPatch input must be JSON-serializable')
  if (Buffer.byteLength(encoded, 'utf8') > APPLY_PATCH_MAX_INPUT_BYTES)
    throw new Error('ApplyPatch input exceeds 256 KiB')
  const object = objectInput(input, 'ApplyPatch input')
  exactKeys(object, ['edits'])
  const rawEdits = object.edits
  if (
    !Array.isArray(rawEdits) ||
    rawEdits.length < 1 ||
    rawEdits.length > APPLY_PATCH_MAX_EDITS
  )
    throw new Error('ApplyPatch edits must contain 1 to 32 operations')
  return rawEdits.map((raw, index) => {
    const item = objectInput(raw, `ApplyPatch edits[${index}]`)
    exactKeys(item, ['file_path', 'old_string', 'new_string'])
    const edit = {
      file_path: stringInput(item, 'file_path', true),
      old_string: stringInput(item, 'old_string', true),
      new_string: stringInput(item, 'new_string'),
    }
    if (edit.old_string === edit.new_string)
      throw new Error('new_string must differ from old_string')
    return edit
  })
}

export function planApplyPatch(
  edits: readonly ApplyPatchEdit[],
  sources: ReadonlyMap<string, string>,
  maxFileBytes: number,
): ApplyPatchPlan {
  if (edits.length < 1 || edits.length > APPLY_PATCH_MAX_EDITS)
    throw new Error('ApplyPatch edits must contain 1 to 32 operations')
  if (new Set(edits.map((edit) => edit.file_path)).size > APPLY_PATCH_MAX_FILES)
    throw new Error('ApplyPatch may touch at most 8 files')
  const snapshots = new Map<string, string>()
  for (const edit of edits) {
    if (!edit.old_string) throw new Error('old_string must be non-empty')
    if (edit.old_string === edit.new_string)
      throw new Error('new_string must differ from old_string')
    if (!snapshots.has(edit.file_path)) {
      const source = sources.get(edit.file_path)
      if (source === undefined)
        throw new Error(`ApplyPatch source is missing: ${edit.file_path}`)
      snapshots.set(edit.file_path, source)
    }
  }
  for (const edit of edits) {
    const source = snapshots.get(edit.file_path)
    if (source === undefined)
      throw new Error(`ApplyPatch source is missing: ${edit.file_path}`)
    const first = source.indexOf(edit.old_string)
    if (first < 0) throw new Error('old_string was not found')
    const second = source.indexOf(
      edit.old_string,
      first + edit.old_string.length,
    )
    if (second >= 0) throw new Error('old_string must match exactly once')
    const after =
      source.slice(0, first) +
      edit.new_string +
      source.slice(first + edit.old_string.length)
    if (Buffer.byteLength(after, 'utf8') > maxFileBytes)
      throw new Error(`Edited content exceeds ${maxFileBytes} bytes`)
    snapshots.set(edit.file_path, after)
  }
  const files = [...snapshots].map(([filePath, after]) => {
    const before = sources.get(filePath)
    if (before === undefined)
      throw new Error(`ApplyPatch source is missing: ${filePath}`)
    const changes = countLineChanges(before, after)
    return { filePath, before, after, ...changes }
  })
  return {
    files,
    linesAdded: files.reduce((total, file) => total + file.linesAdded, 0),
    linesRemoved: files.reduce((total, file) => total + file.linesRemoved, 0),
  }
}
