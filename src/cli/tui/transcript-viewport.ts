import { stripVTControlCharacters } from 'node:util'
import type {
  TranscriptPresentationEntry,
  TranscriptPresentationMode,
} from './transcript-presentation.js'

export const FULLSCREEN_TRANSCRIPT_RESERVED_ROWS = 12
export const TRANSCRIPT_TRUNCATION_MARKER = '…'

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
})

const zeroWidthClusterPattern =
  /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Nonspacing_Mark}|\p{Enclosing_Mark}|\p{Surrogate})+$/v
const leadingNonPrintingPattern =
  /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Nonspacing_Mark}\p{Enclosing_Mark}\p{Surrogate}]+/v
const rgiEmojiPattern = /^\p{RGI_Emoji}$/v
const extendedPictographicPattern = /\p{Extended_Pictographic}/gu
const spacingMarkPattern = /\p{Spacing_Mark}/v
const unqualifiedKeycapPattern = /^[\d#*]\u20e3$/u

function graphemes(text: string): readonly string[] {
  return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment)
}

function isPrintableAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x20 || code > 0x7e) return false
  }
  return true
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
      (codePoint >= 0x3040 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1b000 && codePoint <= 0x1b001) ||
      (codePoint >= 0x1f200 && codePoint <= 0x1f251) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  )
}

function isDoubleWidthEmoji(cluster: string): boolean {
  if (rgiEmojiPattern.test(cluster) || unqualifiedKeycapPattern.test(cluster))
    return true
  if (!cluster.includes('\u200d') || cluster.length > 50) return false
  return (cluster.match(extendedPictographicPattern)?.length ?? 0) >= 2
}

function graphemeWidth(cluster: string): number {
  if (!cluster || zeroWidthClusterPattern.test(cluster)) return 0
  if (isDoubleWidthEmoji(cluster)) return 2
  const visible = cluster.replace(leadingNonPrintingPattern, '')
  const first = visible.codePointAt(0)
  if (first === undefined) return 0
  let width = isWideCodePoint(first) ? 2 : 1
  let firstVisible = true
  for (const character of visible) {
    if (firstVisible) {
      firstVisible = false
      continue
    }
    const codePoint = character.codePointAt(0)
    if (
      codePoint !== undefined &&
      (spacingMarkPattern.test(character) ||
        (codePoint >= 0xff00 && codePoint <= 0xffef))
    )
      width += isWideCodePoint(codePoint) ? 2 : 1
  }
  return width
}

function terminalStringWidth(text: string): number {
  if (isPrintableAscii(text)) return text.length
  const first = text.codePointAt(0)
  if (first !== undefined && text.length === (first > 0xffff ? 2 : 1)) {
    if (first <= 0x1f || (first >= 0x7f && first <= 0x9f)) return 0
    if (isWideCodePoint(first)) return 2
    return first <= 0xffff ? 1 : isDoubleWidthEmoji(text) ? 2 : 1
  }
  return graphemes(text).reduce(
    (width, cluster) => width + graphemeWidth(cluster),
    0,
  )
}

function expandTabs(line: string): string {
  if (!line.includes('\t')) return line
  let column = 0
  let expanded = ''
  for (const cluster of graphemes(line)) {
    if (cluster === '\t') {
      const spaces = 8 - (column % 8)
      expanded += ' '.repeat(spaces)
      column += spaces
      continue
    }
    expanded += cluster
    column += graphemeWidth(cluster)
  }
  return expanded
}

type WrapState = { rows: number; column: number }

function hardWrappedRows(
  word: string,
  width: number,
  startColumn: number,
): WrapState {
  if (word.length === 0) return { rows: 0, column: startColumn }
  if (isPrintableAscii(word)) {
    const occupied = startColumn + word.length
    return {
      rows: Math.max(0, Math.ceil(occupied / width) - 1),
      column: occupied % width || width,
    }
  }
  const clusters = graphemes(word)
  let rows = 0
  let column = startColumn
  for (const [index, cluster] of clusters.entries()) {
    const clusterWidth = graphemeWidth(cluster)
    if (column + clusterWidth > width) {
      rows += 1
      column = clusterWidth
    } else {
      column += clusterWidth
    }
    if (column === width && index < clusters.length - 1) {
      rows += 1
      column = 0
    }
  }
  return { rows, column }
}

function wrappedLineRows(line: string, width: number): number {
  const expanded = expandTabs(line)
  if (isPrintableAscii(expanded) && expanded.length <= width) return 1
  const words = expanded.split(' ')
  let rows = 1
  let column = 0
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? ''
    const wordWidth = isPrintableAscii(word)
      ? word.length
      : terminalStringWidth(word)
    if (index > 0) {
      if (column >= width) {
        rows += 1
        column = 0
      }
      column += 1
    }
    if (wordWidth > width) {
      const current = hardWrappedRows(word, width, column)
      const fresh = hardWrappedRows(word, width, 0)
      if (column > 0 && current.rows > fresh.rows) {
        rows += 1
        column = 0
        rows += fresh.rows
        column = fresh.column
      } else {
        rows += current.rows
        column = current.column
      }
      continue
    }
    if (column + wordWidth > width && column > 0 && word.length > 0) {
      rows += 1
      column = 0
    }
    column += wordWidth
  }
  return rows
}

function wrappedLineCount(text: string, width: number): number {
  const usable = Math.max(1, width)
  if (isPrintableAscii(text))
    return text.length <= usable ? 1 : wrappedLineRows(text, usable)
  const visible =
    text.includes('\u001b') || text.includes('\u009b')
      ? stripVTControlCharacters(text)
      : text
  return visible
    .normalize()
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .reduce((rows, line) => rows + wrappedLineRows(line, usable), 0)
}

function markdownContentWidth(width: number): number {
  return Math.max(1, width - 4)
}

function bounded(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

function contentLines(text: string): readonly string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/u, '')}m`
  if (tokens >= 1_000)
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/u, '')}k`
  return String(tokens)
}

function percent(tokens: number, total: number): string {
  return `${Math.round((tokens / Math.max(1, total)) * 100 * 10) / 10}%`
}

function contextUsageLineCount(
  item: Extract<
    Extract<TranscriptPresentationEntry, { kind: 'item' }>['item'],
    { kind: 'context' }
  >,
  width: number,
): number {
  const totalTokens = Math.max(1, item.contextWindowTokens)
  const compactBuffer = Math.round(totalTokens * 0.165)
  const usable = Math.max(1, totalTokens - compactBuffer)
  const rightWidth = Math.max(1, width - 16)
  const rightColumnRows = [
    `${item.model ?? 'provider default'} · ${compactTokens(item.usedTokens)}/${compactTokens(totalTokens)} tokens (${percent(item.usedTokens, totalTokens)})`,
    ' ',
    'Estimated usage by category',
    `⛁ Messages and other context: ${compactTokens(item.usedTokens)} tokens (${percent(item.usedTokens, totalTokens)})`,
    `⛶ Free space: ${compactTokens(Math.max(0, usable - item.usedTokens))} (${percent(Math.max(0, usable - item.usedTokens), totalTokens)})`,
    `⛝ Autocompact buffer: ${compactTokens(compactBuffer)} tokens (${percent(compactBuffer, totalTokens)})`,
  ].reduce((rows, line) => rows + wrappedLineCount(line, rightWidth), 0)
  const gridRows = Math.max(width < 48 ? 10 : 5, rightColumnRows)
  const memoryRows = item.memoryFiles.length
    ? item.memoryFiles.reduce(
        (rows, file, index) =>
          rows +
          wrappedLineCount(
            `${index === item.memoryFiles.length - 1 ? '└' : '├'} ${file.path}: ${file.tokens} tokens`,
            Math.max(1, width - 2),
          ),
        0,
      )
    : wrappedLineCount('└ No memory files', Math.max(1, width - 2))
  const skillRows = item.skills.length
    ? item.skills.reduce(
        (rows, skill, index) =>
          rows +
          wrappedLineCount(
            `${index === item.skills.length - 1 ? '└' : '├'} ${skill.name}: ~${skill.tokens} tokens`,
            Math.max(1, width - 2),
          ),
        0,
      )
    : wrappedLineCount('└ No skills loaded', Math.max(1, width - 2))
  return 8 + gridRows + memoryRows + skillRows
}

function combinedShellOutput(stdout: string, stderr: string): string {
  return [stdout, stderr]
    .filter(Boolean)
    .join(stdout && stderr && !stdout.endsWith('\n') ? '\n' : '')
}

function orphanShellOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join('\n')
}

function inputString(
  entry: Extract<TranscriptPresentationEntry, { kind: 'tool' }>,
  key: string,
): string {
  const value = entry.item.call.input[key]
  return typeof value === 'string' ? value : ''
}

function toolHeading(
  entry: Extract<TranscriptPresentationEntry, { kind: 'tool' }>,
): string {
  if (entry.item.call.name === 'Edit')
    return `Update(${inputString(entry, 'file_path')})`
  if (entry.item.call.name === 'Read')
    return `Read(${inputString(entry, 'file_path')})`
  if (entry.item.call.name === 'Bash')
    return `Bash(${inputString(entry, 'command')})`
  return entry.item.call.name
}

function visibleOutputLineCount(
  text: string,
  width: number,
  mode: TranscriptPresentationMode,
): number {
  const lines = contentLines(text)
  const visible = mode === 'normal' ? lines.slice(0, 3) : lines
  const outputWidth = Math.max(1, width - 2)
  const rows = visible.reduce(
    (total, line, index) =>
      total +
      wrappedLineCount(
        `${index === 0 ? '⎿ ' : '   '}${line || ' '}`,
        outputWidth,
      ),
    0,
  )
  return (
    rows +
    (mode === 'normal' && lines.length > visible.length
      ? wrappedLineCount(
          `   … +${lines.length - visible.length} lines (ctrl+o to expand)`,
          outputWidth,
        )
      : 0)
  )
}

function screenReaderContextLineCount(
  item: Extract<
    Extract<TranscriptPresentationEntry, { kind: 'item' }>['item'],
    { kind: 'context' }
  >,
  width: number,
): number {
  const totalTokens = Math.max(1, item.contextWindowTokens)
  const compactBuffer = Math.round(totalTokens * 0.165)
  return [
    'Context Usage',
    `${item.model ?? 'provider default'} · ${item.usedTokens.toLocaleString()}/${totalTokens.toLocaleString()} tokens (${percent(item.usedTokens, totalTokens)})`,
    `Autocompact buffer: ${compactBuffer.toLocaleString()} tokens`,
    `Skills: ${item.skills.map(({ name }) => name).join(', ') || 'none'}`,
  ].reduce((rows, line) => rows + wrappedLineCount(line, width), 0)
}

function textTail(text: string, budget: number, width: number): string {
  const usableBudget = Math.max(1, budget)
  const usableWidth = Math.max(1, width)
  if (wrappedLineCount(text, usableWidth) <= usableBudget) return text
  const lines = text.split('\n')
  const kept: string[] = []
  let rowsAfter = 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? ''
    const markedRows = wrappedLineCount(
      `${TRANSCRIPT_TRUNCATION_MARKER}${line}`,
      usableWidth,
    )
    if (rowsAfter + markedRows <= usableBudget) {
      kept.unshift(line)
      rowsAfter += wrappedLineCount(line, usableWidth)
      continue
    }

    const remainingRows = usableBudget - rowsAfter
    if (remainingRows > 0) {
      const clusters = graphemes(line)
      let low = 0
      let high = clusters.length
      let suffix = ''
      while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const candidate = clusters.slice(clusters.length - middle).join('')
        if (
          wrappedLineCount(
            `${TRANSCRIPT_TRUNCATION_MARKER}${candidate}`,
            usableWidth,
          ) <= remainingRows
        ) {
          suffix = candidate
          low = middle + 1
        } else {
          high = middle - 1
        }
      }
      while (
        suffix &&
        wrappedLineCount(
          `${TRANSCRIPT_TRUNCATION_MARKER}${suffix}`,
          usableWidth,
        ) > remainingRows
      ) {
        const suffixClusters = graphemes(suffix)
        suffix = suffixClusters.slice(0, -1).join('')
      }
      kept.unshift(suffix)
    }
    break
  }
  return `${TRANSCRIPT_TRUNCATION_MARKER}${kept.join('\n')}`
}

export function estimateTranscriptEntryLines(
  entry: TranscriptPresentationEntry,
  width: number,
  mode: TranscriptPresentationMode,
): number {
  if (entry.kind === 'read-summary')
    return wrappedLineCount(
      `  Read ${entry.count} file${entry.count === 1 ? '' : 's'} (ctrl+o to expand)`,
      width,
    )
  if (entry.kind === 'item') {
    const item = entry.item
    if (item.kind === 'user')
      return (
        1 +
        (mode === 'screen-reader' ? 1 : 0) +
        wrappedLineCount(
          `${mode === 'screen-reader' ? 'You: ' : '❯ '}${item.text}`,
          width,
        )
      )
    if (item.kind === 'assistant')
      return (
        1 +
        (mode === 'screen-reader' ? 1 : 0) +
        wrappedLineCount(
          item.text,
          mode === 'screen-reader'
            ? Math.max(1, width - 7)
            : markdownContentWidth(width),
        )
      )
    if (item.kind === 'thinking') {
      const summary = item.text.replace(/\s+/gu, ' ').trim()
      if (mode === 'normal')
        return (
          1 +
          wrappedLineCount(
            `✻ Thought for a moment${summary ? ` · ${summary.slice(0, 160)}` : ''}`,
            width,
          ) +
          (summary.length > 160
            ? wrappedLineCount(' ctrl+o to expand thinking', width)
            : 0)
        )
      const heading =
        mode === 'screen-reader'
          ? 'Thinking:Thought for a moment'
          : `✻ Thought for a moment${summary ? ` · ${summary.slice(0, 160)}` : ''}`
      return (
        1 +
        wrappedLineCount(heading, width) +
        wrappedLineCount(
          item.text,
          mode === 'screen-reader' ? width : markdownContentWidth(width),
        )
      )
    }
    if (item.kind === 'compact') {
      if (mode === 'screen-reader')
        return 2 + wrappedLineCount(item.summary, markdownContentWidth(width))
      return (
        1 +
        wrappedLineCount(
          '✻ Conversation compacted (ctrl+o for history)',
          width,
        ) +
        (mode === 'audit'
          ? wrappedLineCount(item.summary, markdownContentWidth(width))
          : 0)
      )
    }
    if (item.kind === 'context')
      return mode === 'screen-reader'
        ? screenReaderContextLineCount(item, width)
        : contextUsageLineCount(item, width)
    if (item.kind === 'local-result')
      return wrappedLineCount(`⎿ ${item.text}`, Math.max(1, width - 2))
    if (item.kind === 'notice') return wrappedLineCount(`· ${item.text}`, width)
    if (item.kind === 'warning')
      return wrappedLineCount(`⚠ ${item.text}`, width)
    return wrappedLineCount(item.text, width)
  }
  if (entry.kind === 'orphan-tool-result')
    return (
      1 +
      wrappedLineCount(bounded(entry.item.text, 500), Math.max(1, width - 2))
    )
  if (entry.kind === 'orphan-shell-result')
    return wrappedLineCount(
      `⎿ ${orphanShellOutput(entry.item.stdout, entry.item.stderr)}`,
      width,
    )
  if (entry.kind === 'tool') {
    if (
      mode === 'normal' &&
      entry.item.call.name === 'Read' &&
      entry.result &&
      !entry.result.isError
    )
      return 1
    let rows = 1 + wrappedLineCount(`⏺ ${toolHeading(entry)}`, width)
    if (
      !['Bash', 'Read', 'Edit'].includes(entry.item.call.name) &&
      entry.item.detail
    )
      rows += wrappedLineCount(` ${entry.item.detail}`, width)
    if (!entry.result) return rows
    if (entry.result.isError)
      return (
        rows +
        wrappedLineCount(
          `⎿ Error: ${bounded(entry.result.text, 500)}`,
          Math.max(1, width - 2),
        )
      )
    if (entry.item.call.name === 'Edit') {
      const newLines = contentLines(inputString(entry, 'new_string'))
      const oldLines = contentLines(inputString(entry, 'old_string'))
      rows += wrappedLineCount(
        `⎿ Added ${newLines.length} line${newLines.length === 1 ? '' : 's'}, removed ${oldLines.length} line${oldLines.length === 1 ? '' : 's'}`,
        Math.max(1, width - 2),
      )
      if (mode !== 'normal') {
        rows += oldLines.reduce(
          (total, line, index) =>
            total +
            wrappedLineCount(
              `   ${index + 1} -${line}`,
              Math.max(1, width - 2),
            ),
          0,
        )
        rows += newLines.reduce(
          (total, line, index) =>
            total +
            wrappedLineCount(
              `   ${index + 1} +${line}`,
              Math.max(1, width - 2),
            ),
          0,
        )
      }
      return rows
    }
    return rows + visibleOutputLineCount(entry.result.text, width, mode)
  }
  let rows =
    1 +
    wrappedLineCount(
      `${mode === 'screen-reader' ? 'Shell command: ' : '! '}${entry.item.command}`,
      width,
    )
  if (!entry.result) return rows
  const output = combinedShellOutput(entry.result.stdout, entry.result.stderr)
  const lines = contentLines(output)
  if (lines.length === 0)
    return rows + wrappedLineCount('⎿ ', Math.max(1, width - 2))
  rows += visibleOutputLineCount(output, width, mode)
  return rows
}
export function transcriptPresentationLineCount(
  entries: readonly TranscriptPresentationEntry[],
  width: number,
  mode: TranscriptPresentationMode,
): number {
  return entries.reduce(
    (n, entry) => n + estimateTranscriptEntryLines(entry, width, mode),
    0,
  )
}

function fitEntryText<T extends TranscriptPresentationEntry>(
  entry: T,
  value: string,
  replace: (source: T, projectedValue: string) => T,
  budget: number,
  viewportWidth: number,
  contentWidth: number,
  mode: TranscriptPresentationMode,
): T {
  if (
    estimateTranscriptEntryLines(entry, viewportWidth, mode) <= budget ||
    !value
  )
    return entry
  const withoutValue = replace(entry, '')
  const remaining =
    budget - estimateTranscriptEntryLines(withoutValue, viewportWidth, mode)
  if (remaining <= 0) return withoutValue
  const candidate = textTail(value, remaining, contentWidth)
  const projected = replace(entry, candidate)
  if (estimateTranscriptEntryLines(projected, viewportWidth, mode) <= budget)
    return projected
  const clusters = graphemes(candidate)
  let low = 0
  let high = clusters.length
  let suffix = ''
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const next = clusters.slice(clusters.length - middle).join('')
    const nextEntry = replace(entry, next)
    if (
      estimateTranscriptEntryLines(nextEntry, viewportWidth, mode) <= budget
    ) {
      suffix = next
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return suffix ? replace(entry, suffix) : withoutValue
}

type ToolPresentationEntry = Extract<
  TranscriptPresentationEntry,
  { kind: 'tool' }
>

function replaceToolInput(
  entry: ToolPresentationEntry,
  key: string,
  value: string,
): ToolPresentationEntry {
  return {
    ...entry,
    item: {
      ...entry.item,
      call: {
        ...entry.item.call,
        input: { ...entry.item.call.input, [key]: value },
      },
    },
  }
}

function projectOversizedEntry(
  entry: TranscriptPresentationEntry,
  budget: number,
  width: number,
  mode: TranscriptPresentationMode,
): TranscriptPresentationEntry {
  if (entry.kind === 'item') {
    const item = entry.item
    if (item.kind === 'thinking')
      return {
        ...entry,
        item: {
          ...item,
          text: textTail(
            item.text,
            Math.max(1, budget - 2),
            markdownContentWidth(width),
          ),
        },
      }
    if (item.kind === 'compact')
      return {
        ...entry,
        item: {
          ...item,
          summary: textTail(
            item.summary,
            Math.max(1, budget - 2),
            markdownContentWidth(width),
          ),
        },
      }
    if ('text' in item)
      return {
        ...entry,
        item: {
          ...item,
          text: textTail(
            item.text,
            Math.max(
              1,
              budget -
                (item.kind === 'user'
                  ? 1
                  : item.kind === 'assistant'
                    ? mode === 'screen-reader'
                      ? 2
                      : 1
                    : 0),
            ),
            item.kind === 'assistant'
              ? mode === 'screen-reader'
                ? Math.max(1, width - 7)
                : markdownContentWidth(width)
              : item.kind === 'user'
                ? Math.max(1, width - (mode === 'screen-reader' ? 5 : 2))
                : Math.max(1, width - (item.kind === 'local-result' ? 4 : 2)),
          ),
        },
      }
  }
  if (entry.kind === 'tool') {
    let projected = entry
    if (!['Bash', 'Read', 'Edit'].includes(projected.item.call.name)) {
      projected = fitEntryText(
        projected,
        projected.item.detail,
        (source, detail) => ({
          ...source,
          item: { ...source.item, detail },
        }),
        budget,
        width,
        Math.max(1, width - 1),
        mode,
      )
    }

    const inputKeys =
      projected.item.call.name === 'Edit'
        ? ['file_path', 'old_string', 'new_string']
        : projected.item.call.name === 'Read'
          ? ['file_path']
          : projected.item.call.name === 'Bash'
            ? ['command']
            : []
    for (const key of inputKeys) {
      const value = inputString(projected, key)
      projected = fitEntryText(
        projected,
        value,
        (source, projectedValue) =>
          replaceToolInput(source, key, projectedValue),
        budget,
        width,
        Math.max(1, width - (key === 'file_path' ? 12 : 8)),
        mode,
      )
    }

    const result = projected.result
    if (result) {
      projected = fitEntryText(
        projected,
        result.text,
        (source, text) => ({
          ...source,
          result: { ...result, text },
        }),
        budget,
        width,
        Math.max(1, width - 5),
        mode,
      )
    }
    return projected
  }

  if (entry.kind === 'shell') {
    let projected = fitEntryText(
      entry,
      entry.item.command,
      (source, command) => ({
        ...source,
        item: { ...source.item, command },
      }),
      budget,
      width,
      Math.max(1, width - 4),
      mode,
    )
    const result = projected.result
    if (result) {
      const combined = combinedShellOutput(result.stdout, result.stderr)
      projected = fitEntryText(
        projected,
        combined,
        (source, stdout) => ({
          ...source,
          result: { ...result, stdout, stderr: '' },
        }),
        budget,
        width,
        Math.max(1, width - 5),
        mode,
      )
    }
    return projected
  }
  if (entry.kind === 'orphan-tool-result')
    return {
      ...entry,
      item: {
        ...entry.item,
        text: textTail(
          entry.item.text,
          Math.max(1, budget - 1),
          Math.max(1, width - 2),
        ),
      },
    }
  if (entry.kind === 'orphan-shell-result') {
    const combined = orphanShellOutput(entry.item.stdout, entry.item.stderr)
    return {
      ...entry,
      item: {
        ...entry.item,
        stdout: textTail(combined, budget, Math.max(1, width - 2)),
        stderr: '',
      },
    }
  }
  return entry
}
export function projectTranscriptPresentationTail(
  entries: readonly TranscriptPresentationEntry[],
  budget: number,
  width: number,
  mode: TranscriptPresentationMode,
): readonly TranscriptPresentationEntry[] {
  if (!entries.length) return []
  const limit = Math.max(1, budget)
  let rows = 0
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (!entry) continue
    const count = estimateTranscriptEntryLines(entry, width, mode)
    if (rows + count > limit) {
      if (i !== entries.length - 1) return entries.slice(i + 1)
      const projected = projectOversizedEntry(entry, limit, width, mode)
      return estimateTranscriptEntryLines(projected, width, mode) <= limit
        ? [projected]
        : []
    }
    rows += count
  }
  return entries
}

function projectTranscriptPresentationStart(
  entries: readonly TranscriptPresentationEntry[],
  budget: number,
  width: number,
  mode: TranscriptPresentationMode,
): readonly TranscriptPresentationEntry[] {
  const limit = Math.max(1, budget)
  let rows = 0
  let end = 0
  for (const entry of entries) {
    const count = estimateTranscriptEntryLines(entry, width, mode)
    if (rows + count > limit) {
      if (end > 0) break
      const projected = projectOversizedEntry(entry, limit, width, mode)
      return estimateTranscriptEntryLines(projected, width, mode) <= limit
        ? [projected]
        : []
    }
    rows += count
    end += 1
  }
  return entries.slice(0, end)
}

export function projectTranscriptPresentationWindow(
  entries: readonly TranscriptPresentationEntry[],
  budget: number,
  width: number,
  scrollOffset: number,
  mode: TranscriptPresentationMode,
): readonly TranscriptPresentationEntry[] {
  if (scrollOffset <= 0)
    return projectTranscriptPresentationTail(entries, budget, width, mode)
  const limit = Math.max(1, budget)
  const totalRows = transcriptPresentationLineCount(entries, width, mode)
  const clampedOffset = Math.min(
    Math.max(0, scrollOffset),
    Math.max(0, totalRows - limit),
  )
  const startRows = Math.max(0, totalRows - clampedOffset - limit)
  const endRows = totalRows - clampedOffset
  let rows = 0
  let start = entries.length
  let startBeforeRows = 0
  let startEntryRows = 0
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    if (!entry) continue
    const count = estimateTranscriptEntryLines(entry, width, mode)
    const next = rows + count
    if (start === entries.length && next > startRows) {
      start = i
      startBeforeRows = rows
      startEntryRows = count
    }
    rows = next
  }
  if (start === entries.length) return []

  let completeEnd = start - 1
  rows = 0
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    if (!entry) continue
    rows += estimateTranscriptEntryLines(entry, width, mode)
    if (rows <= endRows) completeEnd = i
    if (rows >= endRows) break
  }

  const offsetWithinStart = startRows - startBeforeRows
  const remainingStartRows = startEntryRows - offsetWithinStart
  if (completeEnd < start) {
    const entry = entries[start]
    if (!entry) return []
    return projectTranscriptPresentationStart([entry], limit, width, mode)
  }

  let candidates = entries.slice(start, completeEnd + 1)
  if (offsetWithinStart > 0) {
    const entry = candidates[0]
    if (entry) {
      const allowance = Math.min(limit, Math.max(1, remainingStartRows))
      candidates = [
        projectOversizedEntry(entry, allowance, width, mode),
        ...candidates.slice(1),
      ]
    }
  }
  return projectTranscriptPresentationStart(candidates, limit, width, mode)
}
