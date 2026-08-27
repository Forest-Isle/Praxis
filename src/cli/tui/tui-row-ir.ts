import { stripVTControlCharacters } from 'node:util'

import type {
  TranscriptItem,
  TranscriptPresentationEntry,
  TranscriptPresentationMode,
} from './transcript-presentation.js'
import { projectTranscriptEntryRows } from './transcript-viewport.js'

export type TuiTextRole =
  | 'body'
  | 'heading'
  | 'muted'
  | 'accent'
  | 'success'
  | 'warning'
  | 'error'
  | 'tool'
  | 'selection'
  | 'input'
  | 'diffAdded'
  | 'diffRemoved'

export interface TuiRowSegment {
  readonly text: string
  readonly role: TuiTextRole
}

export interface TuiRow {
  readonly key: string
  readonly segments: readonly TuiRowSegment[]
  readonly height: number
  readonly source?: string
}

export interface TuiRowProjectionInput {
  readonly entries: readonly TranscriptPresentationEntry[]
  readonly width: number
  readonly mode: TranscriptPresentationMode
}

type StyledText = { readonly text: string; readonly role: TuiTextRole }

function toolHeading(item: Extract<TranscriptItem, { kind: 'tool' }>): string {
  const input = item.call.input
  const value = (key: string) =>
    typeof input[key] === 'string' ? String(input[key]) : ''
  if (item.call.name === 'Read') return `Read(${value('file_path')})`
  if (item.call.name === 'Edit') return `Update(${value('file_path')})`
  if (item.call.name === 'Bash') return `Bash(${value('command')})`
  return item.call.name
}

function entryText(entry: TranscriptPresentationEntry): StyledText {
  if (entry.kind === 'read-summary')
    return {
      text: `Read ${entry.count} file${entry.count === 1 ? '' : 's'}`,
      role: 'muted',
    }
  if (entry.kind === 'item') {
    const item = entry.item
    if (item.kind === 'user') return { text: `❯ ${item.text}`, role: 'body' }
    if (item.kind === 'assistant')
      return { text: `⏺ ${item.text}`, role: 'body' }
    if (item.kind === 'thinking')
      return { text: `✻ ${item.text}`, role: 'muted' }
    if (item.kind === 'notice') return { text: `· ${item.text}`, role: 'muted' }
    if (item.kind === 'warning')
      return { text: `⚠ ${item.text}`, role: 'error' }
    if (item.kind === 'local-result')
      return { text: `⎿ ${item.text}`, role: 'muted' }
    if (item.kind === 'compact')
      return {
        text: `Conversation compacted: ${item.summary}`,
        role: 'heading',
      }
    if (item.kind === 'context')
      return {
        text: `Context Usage · ${item.usedTokens}/${item.contextWindowTokens} tokens`,
        role: 'heading',
      }
  }
  if (entry.kind === 'tool') {
    const result = entry.result
    const output = result
      ? result.isError
        ? `\n⎿ Error: ${result.text}`
        : `\n${result.text}`
      : ''
    return {
      text: `⏺ ${toolHeading(entry.item)}${entry.item.detail ? `\n ${entry.item.detail}` : ''}${output}`,
      role: result?.isError ? 'error' : 'tool',
    }
  }
  if (entry.kind === 'shell') {
    const result = entry.result
    const output = result
      ? `\n${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`
      : ''
    return {
      text: `! ${entry.item.command}${output}`,
      role: result?.isError ? 'error' : 'tool',
    }
  }
  if (entry.kind === 'orphan-tool-result')
    return {
      text: `⎿ ${entry.item.text}`,
      role: entry.item.isError ? 'error' : 'muted',
    }
  if (entry.kind === 'orphan-shell-result')
    return {
      text: `⎿ ${entry.item.stdout}${entry.item.stderr ? `\n${entry.item.stderr}` : ''}`,
      role: entry.item.isError ? 'error' : 'muted',
    }
  throw new Error(`Unsupported transcript entry kind: ${entry.kind}`)
}

function lineRole(
  entry: TranscriptPresentationEntry,
  role: TuiTextRole,
  line: string,
): TuiTextRole {
  if (entry.kind === 'tool' && /^\s*[-]/u.test(line)) return 'diffRemoved'
  if (entry.kind === 'tool' && /^\s*[+]/u.test(line)) return 'diffAdded'
  return role
}

export function projectTuiRows(
  input: TuiRowProjectionInput,
): readonly TuiRow[] {
  const rows: TuiRow[] = []
  for (const entry of input.entries) {
    const styled = entry.viewportSlice
      ? {
          text: entry.viewportSlice.text,
          role:
            entry.kind === 'tool' ? ('tool' as const) : entryText(entry).role,
        }
      : entryText(entry)
    const authoritativeRows = entry.viewportSlice
      ? undefined
      : projectTranscriptEntryRows(entry, input.width, input.mode)
    const lines = authoritativeRows
      ? authoritativeRows.map((line) => stripVTControlCharacters(line))
      : stripVTControlCharacters(styled.text)
          .replace(/\r\n?/gu, '\n')
          .split('\n')
    lines.forEach((line, lineIndex) => {
      const text = line.length === 0 ? ' ' : line
      const assistantHeading =
        entry.kind === 'item' &&
        entry.item.kind === 'assistant' &&
        !entry.viewportSlice &&
        !authoritativeRows &&
        lineIndex === 0 &&
        text.startsWith('⏺ ')
      rows.push({
        key: `${entry.key}:${lineIndex}`,
        segments: assistantHeading
          ? [
              { text: '⏺ ', role: 'heading' },
              { text: text.slice(2), role: 'body' },
            ]
          : [{ text, role: lineRole(entry, styled.role, line) }],
        height: 1,
        source: entry.key,
      })
    })
  }
  return rows
}
