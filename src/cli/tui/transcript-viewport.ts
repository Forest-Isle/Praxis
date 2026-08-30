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

export function terminalGraphemes(text: string): readonly string[] {
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

export function terminalGraphemeWidth(cluster: string): number {
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

export function terminalTextWidth(text: string): number {
  if (isPrintableAscii(text)) return text.length
  const first = text.codePointAt(0)
  if (first !== undefined && text.length === (first > 0xffff ? 2 : 1)) {
    if (first <= 0x1f || (first >= 0x7f && first <= 0x9f)) return 0
    if (isWideCodePoint(first)) return 2
    return first <= 0xffff ? 1 : isDoubleWidthEmoji(text) ? 2 : 1
  }
  return terminalGraphemes(text).reduce(
    (width, cluster) => width + terminalGraphemeWidth(cluster),
    0,
  )
}

export function terminalTextHead(text: string, budget: number): string {
  const limit = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0
  let used = 0
  const result: string[] = []
  for (const { segment: cluster } of graphemeSegmenter.segment(text)) {
    const width = terminalGraphemeWidth(cluster)
    if (used + width > limit) break
    result.push(cluster)
    used += width
  }
  return result.join('')
}

export function terminalTextTail(text: string, budget: number): string {
  const limit = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0
  let used = 0
  const result: string[] = []
  for (const cluster of [...terminalGraphemes(text)].reverse()) {
    const width = terminalGraphemeWidth(cluster)
    if (used + width > limit) break
    result.unshift(cluster)
    used += width
  }
  return result.join('')
}

function expandTabs(line: string): string {
  if (!line.includes('\t')) return line
  let column = 0
  let expanded = ''
  for (const cluster of terminalGraphemes(line)) {
    if (cluster === '\t') {
      const spaces = 8 - (column % 8)
      expanded += ' '.repeat(spaces)
      column += spaces
      continue
    }
    expanded += cluster
    column += terminalGraphemeWidth(cluster)
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
  const clusters = terminalGraphemes(word)
  let rows = 0
  let column = startColumn
  for (const [index, cluster] of clusters.entries()) {
    const clusterWidth = terminalGraphemeWidth(cluster)
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

function wrappedLineLayout(
  line: string,
  width: number,
  output?: string[],
): number {
  const expanded = expandTabs(line)
  if (isPrintableAscii(expanded) && expanded.length <= width) {
    output?.push(expanded)
    return 1
  }
  if (expanded.length === 0) {
    output?.push('')
    return 1
  }
  const words = expanded.split(' ')
  let completedRows = 0
  let row = ''
  let column = 0
  const pushRow = () => {
    output?.push(row)
    row = ''
    column = 0
    completedRows += 1
  }
  const appendHardWrappedWord = (word: string) => {
    if (!output) {
      const wrapped = hardWrappedRows(word, width, column)
      completedRows += wrapped.rows
      column = wrapped.column
      return
    }
    const clusters = terminalGraphemes(word)
    for (const [index, cluster] of clusters.entries()) {
      const clusterWidth = terminalGraphemeWidth(cluster)
      if (column + clusterWidth > width) pushRow()
      row += cluster
      column += clusterWidth
      if (column >= width && index < clusters.length - 1) pushRow()
    }
  }
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? ''
    const wordWidth = isPrintableAscii(word)
      ? word.length
      : terminalTextWidth(word)
    if (index > 0) {
      if (column >= width) pushRow()
      if (output) row += ' '
      column += 1
    }
    if (wordWidth > width) {
      const current = hardWrappedRows(word, width, column)
      const fresh = hardWrappedRows(word, width, 0)
      if (column > 0 && current.rows > fresh.rows) {
        pushRow()
      }
      appendHardWrappedWord(word)
      continue
    }
    if (column + wordWidth > width && column > 0 && word.length > 0) {
      pushRow()
    }
    if (output) row += word
    column += wordWidth
  }
  pushRow()
  return completedRows
}

function wrappedLineRows(line: string, width: number): number {
  return wrappedLineLayout(line, width)
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

function oneLine(value: string, max = 160): string {
  const text = stripVTControlCharacters(value)
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}

function toolHeading(
  entry: Extract<TranscriptPresentationEntry, { kind: 'tool' }>,
): string {
  if (entry.item.call.name === 'Edit')
    return `Edit  ${oneLine(inputString(entry, 'file_path'))}`.trimEnd()
  if (entry.item.call.name === 'Read')
    return `Read  ${oneLine(inputString(entry, 'file_path'))}`.trimEnd()
  if (entry.item.call.name === 'Bash')
    return `Bash  ${oneLine(inputString(entry, 'command'))}`.trimEnd()
  return oneLine(entry.item.call.name)
}

function toolSummary(
  entry: Extract<TranscriptPresentationEntry, { kind: 'tool' }>,
  mode: TranscriptPresentationMode,
): string {
  const state = !entry.result
    ? 'running'
    : entry.result.isError
      ? 'failed'
      : 'completed'
  const prefix =
    mode === 'screen-reader'
      ? state === 'running'
        ? 'Running tool: '
        : state === 'failed'
          ? 'Failed tool: '
          : 'Completed tool: '
      : state === 'running'
        ? '… '
        : state === 'failed'
          ? '! '
          : '✓ '
  const detail =
    !['Bash', 'Read', 'Edit'].includes(entry.item.call.name) &&
    entry.item.detail
      ? ` · ${oneLine(entry.item.detail, 120)}`
      : ''
  return `${prefix}${toolHeading(entry)}${detail}`
}

function shellSummary(
  entry: Extract<TranscriptPresentationEntry, { kind: 'shell' }>,
  mode: TranscriptPresentationMode,
): string {
  const state = !entry.result
    ? 'running'
    : entry.result.isError
      ? 'failed'
      : 'completed'
  const prefix =
    mode === 'screen-reader'
      ? state === 'running'
        ? 'Running shell command: '
        : state === 'failed'
          ? 'Failed shell command: '
          : 'Completed shell command: '
      : state === 'running'
        ? '… Bash  '
        : state === 'failed'
          ? '! Bash  '
          : '✓ Bash  '
  return `${prefix}${oneLine(entry.item.command)}`.trimEnd()
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
      const clusters = terminalGraphemes(line)
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
        const suffixClusters = terminalGraphemes(suffix)
        suffix = suffixClusters.slice(0, -1).join('')
      }
      kept.unshift(suffix)
    }
    break
  }
  return `${TRANSCRIPT_TRUNCATION_MARKER}${kept.join('\n')}`
}

function textHead(text: string, budget: number, width: number): string {
  const usableBudget = Math.max(1, budget)
  const usableWidth = Math.max(1, width)
  if (wrappedLineCount(text, usableWidth) <= usableBudget) return text
  const marker = `${TRANSCRIPT_TRUNCATION_MARKER}`
  const lines = text.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    const candidate = [...kept, line, marker].join('\n')
    if (wrappedLineCount(candidate, usableWidth) > usableBudget) break
    kept.push(line)
  }
  let candidate = [...kept, marker].join('\n')
  if (wrappedLineCount(candidate, usableWidth) <= usableBudget) return candidate
  const remaining = Math.max(
    0,
    usableBudget - wrappedLineCount(marker, usableWidth),
  )
  const prefix = kept.join('\n')
  const clusters = terminalGraphemes(prefix)
  let low = 0
  let high = clusters.length
  let best = ''
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const next = clusters.slice(0, middle).join('')
    if (
      wrappedLineCount(`${next}${next ? '\n' : ''}${marker}`, usableWidth) <=
      usableBudget
    ) {
      best = next
      low = middle + 1
    } else high = middle - 1
  }
  candidate = `${best}${best ? '\n' : ''}${marker}`
  return wrappedLineCount(candidate, usableWidth) <= usableBudget
    ? candidate
    : marker.slice(0, Math.max(1, remaining))
}

function textVisualRows(text: string, width: number): readonly string[] {
  const usableWidth = Math.max(1, width)
  const visualRows: string[] = []
  const visible =
    text.includes('\u001b') || text.includes('\u009b')
      ? stripVTControlCharacters(text)
      : text
  for (const logicalLine of visible.replace(/\r\n?/gu, '\n').split('\n'))
    wrappedLineLayout(logicalLine, usableWidth, visualRows)
  return visualRows
}

function textRange(
  text: string,
  startRow: number,
  budget: number,
  width: number,
): string {
  const visualRows = textVisualRows(text, width)
  const limit = Math.max(1, budget)
  const start = Math.min(Math.max(0, startRow), visualRows.length)
  const clippedBefore = start > 0 && limit >= 2
  const available = Math.max(1, limit - (clippedBefore ? 1 : 0))
  let contentBudget = available
  let end = Math.min(visualRows.length, start + contentBudget)
  const clippedAfter = end < visualRows.length && available >= 2
  if (clippedAfter) {
    contentBudget = available - 1
    end = Math.min(visualRows.length, start + contentBudget)
  }
  const selected = visualRows.slice(start, end)
  return [
    ...(clippedBefore ? [TRANSCRIPT_TRUNCATION_MARKER] : []),
    ...selected,
    ...(clippedAfter ? [TRANSCRIPT_TRUNCATION_MARKER] : []),
  ].join('\n')
}

function estimateRenderedTranscriptEntryLines(
  entry: TranscriptPresentationEntry,
  width: number,
  mode: TranscriptPresentationMode,
): number {
  if (entry.kind === 'read-summary')
    return wrappedLineCount(
      `✓ Read ${entry.count} file${entry.count === 1 ? '' : 's'}`,
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
        assistantMarkdownProjectionRows(item.text, width, mode).length
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
          : '✻ Thought for a moment'
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
        return (
          1 +
          wrappedLineCount('Conversation compacted', width) +
          wrappedLineCount(item.summary, markdownContentWidth(width))
        )
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
    const summaryRows = wrappedLineCount(toolSummary(entry, mode), width)
    if (mode === 'normal') {
      if (!entry.result || !entry.result.isError) return summaryRows
      return (
        summaryRows +
        viewportOutputRows(
          `Error: ${bounded(entry.result.text, 500)}`,
          width,
          mode,
        ).length
      )
    }
    let rows = 1 + summaryRows
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
      rows += oldLines.reduce(
        (total, line, index) =>
          total +
          wrappedLineCount(`   ${index + 1} -${line}`, Math.max(1, width - 2)),
        0,
      )
      rows += newLines.reduce(
        (total, line, index) =>
          total +
          wrappedLineCount(`   ${index + 1} +${line}`, Math.max(1, width - 2)),
        0,
      )
      return rows
    }
    return rows + visibleOutputLineCount(entry.result.text, width, mode)
  }
  const summaryRows = wrappedLineCount(shellSummary(entry, mode), width)
  if (mode === 'normal') {
    if (!entry.result || !entry.result.isError) return summaryRows
    const output = combinedShellOutput(entry.result.stdout, entry.result.stderr)
    return (
      summaryRows +
      (output
        ? viewportOutputRows(output, width, mode).length
        : wrappedLineCount('⎿ ', Math.max(1, width - 2)))
    )
  }
  let rows = 1 + summaryRows
  if (!entry.result) return rows
  const output = combinedShellOutput(entry.result.stdout, entry.result.stderr)
  const lines = contentLines(output)
  if (lines.length === 0)
    return rows + wrappedLineCount('⎿ ', Math.max(1, width - 2))
  rows += visibleOutputLineCount(output, width, mode)
  return rows
}

export function estimateTranscriptEntryLines(
  entry: TranscriptPresentationEntry,
  width: number,
  mode: TranscriptPresentationMode,
): number {
  if (entry.viewportSlice) return entry.viewportSlice.rows
  const rendered = estimateRenderedTranscriptEntryLines(entry, width, mode)
  const hasBoundedAuthoritativeText =
    (entry.kind === 'orphan-tool-result' && entry.item.text.length > 500) ||
    (entry.kind === 'tool' &&
      entry.result?.isError === true &&
      entry.result.text.length > 500)
  if (!hasBoundedAuthoritativeText) return rendered
  return entryViewportRows(entry, width, mode)?.length ?? rendered
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

function viewportOutputRows(
  text: string,
  width: number,
  mode: TranscriptPresentationMode,
): readonly string[] {
  const outputWidth = Math.max(1, width - 2)
  if (mode !== 'normal') {
    const lines = contentLines(text)
    return lines.flatMap((line, index) =>
      textVisualRows(
        `${index === 0 ? '⎿ ' : '   '}${line || ' '}`,
        outputWidth,
      ),
    )
  }

  const rows: string[] = []
  const rowBudget = 8
  const lines: string[] = []
  let lineStart = 0
  let omittedLines = 0
  for (let index = 0; index <= text.length && lines.length < 3; index += 1) {
    if (index !== text.length && text[index] !== '\n') continue
    const line = text.slice(lineStart, index).replace(/\r$/u, '')
    if (!(index === text.length && line === '' && text.endsWith('\n')))
      lines.push(line)
    lineStart = index + 1
  }
  for (let index = lineStart; index < text.length; index += 1)
    if (text[index] === '\n') omittedLines += 1
  if (lineStart < text.length && !text.endsWith('\n')) omittedLines += 1
  let hidden = omittedLines > 0
  for (const [index, line] of lines.entries()) {
    const prefix = index === 0 ? '⎿ ' : '   '
    const remaining = rowBudget - rows.length
    if (remaining <= 1) {
      hidden = true
      break
    }
    const candidate = terminalTextHead(
      line || ' ',
      outputWidth * (remaining - 1),
    )
    if (candidate.length < (line || ' ').length) hidden = true
    rows.push(
      ...textVisualRows(`${prefix}${candidate}`, outputWidth).slice(
        0,
        remaining - 1,
      ),
    )
    if (rows.length >= rowBudget - 1) break
  }
  if (hidden) {
    const marker = textVisualRows(
      omittedLines > 0
        ? `   ${TRANSCRIPT_TRUNCATION_MARKER} +${omittedLines} lines (ctrl+o to expand)`
        : `   ${TRANSCRIPT_TRUNCATION_MARKER}`,
      outputWidth,
    )
    if (marker.length <= rowBudget - rows.length)
      rows.push(...marker.slice(0, rowBudget - rows.length))
    else rows.push(TRANSCRIPT_TRUNCATION_MARKER)
  }
  return rows.slice(0, rowBudget)
}

function entryViewportRows(
  entry: TranscriptPresentationEntry,
  width: number,
  mode: TranscriptPresentationMode,
): readonly string[] | undefined {
  if (entry.kind === 'read-summary')
    return textVisualRows(
      `✓ Read ${entry.count} file${entry.count === 1 ? '' : 's'}`,
      width,
    )
  if (entry.kind === 'item') {
    const item = entry.item
    if (item.kind === 'context') return undefined
    if (item.kind === 'user')
      return [
        '',
        ...(mode === 'screen-reader' ? [''] : []),
        ...textVisualRows(
          `${mode === 'screen-reader' ? 'You: ' : '❯ '}${item.text}`,
          width,
        ),
      ]
    if (item.kind === 'assistant')
      return [
        '',
        ...(mode === 'screen-reader' ? ['Praxis:'] : []),
        ...assistantMarkdownProjectionRows(item.text, width, mode).map(
          (row) => row.text,
        ),
      ]
    if (item.kind === 'thinking') {
      const summary = item.text.replace(/\s+/gu, ' ').trim()
      const heading =
        mode === 'screen-reader'
          ? 'Thinking:Thought for a moment'
          : `✻ Thought for a moment${mode === 'normal' && summary ? ` · ${summary.slice(0, 160)}` : ''}`
      if (mode === 'normal')
        return [
          '',
          ...textVisualRows(heading, width),
          ...(summary.length > 160
            ? textVisualRows(' ctrl+o to expand thinking', width)
            : []),
        ]
      return [
        '',
        ...textVisualRows(heading, width),
        ...textVisualRows(
          item.text,
          mode === 'screen-reader' ? width : markdownContentWidth(width),
        ),
      ]
    }
    if (item.kind === 'compact') {
      const heading =
        mode === 'screen-reader'
          ? 'Conversation compacted'
          : '✻ Conversation compacted (ctrl+o for history)'
      return [
        '',
        ...textVisualRows(heading, width),
        ...(mode === 'normal'
          ? []
          : textVisualRows(item.summary, markdownContentWidth(width))),
      ]
    }
    if (item.kind === 'local-result')
      return textVisualRows(`⎿ ${item.text}`, Math.max(1, width - 2))
    if (item.kind === 'warning') return textVisualRows(`⚠ ${item.text}`, width)
    if (item.kind === 'notice') return textVisualRows(`· ${item.text}`, width)
    return textVisualRows(item.text, width)
  }
  if (entry.kind === 'orphan-tool-result')
    return [
      entry.item.isError ? '└ Error' : '└ Result',
      ...textVisualRows(entry.item.text, Math.max(1, width - 2)),
    ]
  if (entry.kind === 'orphan-shell-result')
    return textVisualRows(
      `⎿ ${orphanShellOutput(entry.item.stdout, entry.item.stderr)}`,
      width,
    )
  if (entry.kind === 'shell') {
    const summaryRows = textVisualRows(shellSummary(entry, mode), width)
    if (mode === 'normal') {
      if (!entry.result || !entry.result.isError) return summaryRows
      const output = combinedShellOutput(
        entry.result.stdout,
        entry.result.stderr,
      )
      return [
        ...summaryRows,
        ...(output
          ? viewportOutputRows(output, width, mode)
          : textVisualRows('⎿ ', Math.max(1, width - 2))),
      ]
    }
    const rows = ['', ...summaryRows]
    if (!entry.result) return rows
    const output = combinedShellOutput(entry.result.stdout, entry.result.stderr)
    return [
      ...rows,
      ...(output
        ? viewportOutputRows(output, width, mode)
        : textVisualRows('⎿ ', Math.max(1, width - 2))),
    ]
  }
  const summaryRows = textVisualRows(toolSummary(entry, mode), width)
  if (mode === 'normal') {
    if (!entry.result || !entry.result.isError) return summaryRows
    return [
      ...summaryRows,
      ...viewportOutputRows(
        `Error: ${bounded(entry.result.text, 500)}`,
        width,
        mode,
      ),
    ]
  }
  const rows = ['', ...summaryRows]
  if (!entry.result) return rows
  if (entry.result.isError) {
    rows.push(
      ...textVisualRows(
        `⎿ Error: ${entry.result.text}`,
        Math.max(1, width - 2),
      ),
    )
    return rows
  }
  if (entry.item.call.name === 'Edit') {
    const oldLines = contentLines(inputString(entry, 'old_string'))
    const newLines = contentLines(inputString(entry, 'new_string'))
    rows.push(
      ...textVisualRows(
        `⎿ Added ${newLines.length} line${newLines.length === 1 ? '' : 's'}, removed ${oldLines.length} line${oldLines.length === 1 ? '' : 's'}`,
        Math.max(1, width - 2),
      ),
    )
    for (const [index, line] of oldLines.entries())
      rows.push(
        ...textVisualRows(`   ${index + 1} -${line}`, Math.max(1, width - 2)),
      )
    for (const [index, line] of newLines.entries())
      rows.push(
        ...textVisualRows(`   ${index + 1} +${line}`, Math.max(1, width - 2)),
      )
    return rows
  }
  rows.push(...viewportOutputRows(entry.result.text, width, mode))
  return rows
}

export function projectTranscriptEntryRows(
  entry: TranscriptPresentationEntry,
  width: number,
  mode: TranscriptPresentationMode,
): readonly string[] | undefined {
  return entryViewportRows(entry, Math.max(1, width), mode)
}

interface MarkdownViewportRow {
  readonly text: string
  readonly fenceBefore: boolean
  readonly fenceAfter: boolean
  readonly fenceLabel: string
}

function markdownViewportRows(
  text: string,
  width: number,
): readonly MarkdownViewportRow[] {
  const rows: MarkdownViewportRow[] = []
  let insideFence = false
  let fenceLabel = 'code'
  for (const logicalLine of text.replace(/\r\n?/gu, '\n').split('\n')) {
    if (logicalLine.startsWith('```')) {
      const before = insideFence
      if (!insideFence) fenceLabel = logicalLine.slice(3) || 'code'
      insideFence = !insideFence
      rows.push({
        text: logicalLine,
        fenceBefore: before,
        fenceAfter: insideFence,
        fenceLabel,
      })
      continue
    }
    for (const row of textVisualRows(logicalLine, width))
      rows.push({
        text: row,
        fenceBefore: insideFence,
        fenceAfter: insideFence,
        fenceLabel,
      })
  }
  return rows
}

function assistantMarkdownProjectionRows(
  text: string,
  width: number,
  mode: TranscriptPresentationMode,
): readonly MarkdownViewportRow[] {
  const contentWidth =
    mode === 'screen-reader'
      ? Math.max(1, width - 7)
      : markdownContentWidth(width)
  const rows = markdownViewportRows(text, contentWidth)
  if (mode === 'screen-reader') return rows
  const first = rows[0] ?? {
    text: '',
    fenceBefore: false,
    fenceAfter: false,
    fenceLabel: 'code',
  }
  const prefixed = textVisualRows(`⏺ ${first.text.trimEnd()}`, width).map(
    (rowText) => ({ ...first, text: rowText }),
  )
  return [...prefixed, ...rows.slice(1)]
}

/** Immutable visual-row index retained only for oversized presentation rows. */
export interface TranscriptEntryViewportIndex {
  readonly entry: TranscriptPresentationEntry
  readonly width: number
  readonly mode: TranscriptPresentationMode
  readonly rows: readonly string[]
  readonly assistantMarkdownRows?: readonly MarkdownViewportRow[]
}

export function createTranscriptEntryViewportIndex(
  entry: TranscriptPresentationEntry,
  width: number,
  mode: TranscriptPresentationMode,
): TranscriptEntryViewportIndex | undefined {
  if (entry.kind === 'item' && entry.item.kind === 'assistant') {
    const assistantMarkdownRows = assistantMarkdownProjectionRows(
      entry.item.text,
      width,
      mode,
    )
    return {
      entry,
      width,
      mode,
      rows: [
        '',
        ...(mode === 'screen-reader' ? ['Praxis:'] : []),
        ...assistantMarkdownRows.map((row) => row.text),
      ],
      assistantMarkdownRows,
    }
  }
  const rows = entryViewportRows(entry, width, mode)
  return rows ? { entry, width, mode, rows } : undefined
}

function matchingViewportIndex(
  index: TranscriptEntryViewportIndex | undefined,
  entry: TranscriptPresentationEntry,
  width: number,
  mode: TranscriptPresentationMode,
): TranscriptEntryViewportIndex | undefined {
  return index?.entry === entry && index.width === width && index.mode === mode
    ? index
    : undefined
}

function projectAssistantMarkdownSlice(
  source: Extract<TranscriptPresentationEntry, { kind: 'item' }>,
  sourceText: string | undefined,
  startRow: number,
  budget: number,
  width: number,
  mode: TranscriptPresentationMode,
  viewportIndex?: TranscriptEntryViewportIndex,
): TranscriptPresentationEntry {
  const limit = Math.max(1, budget)
  const sourceChromeRows = 1 + (mode === 'screen-reader' ? 1 : 0)
  const marginTop: 0 | 1 = startRow <= 0 ? 1 : 0
  const projectedChromeRows = marginTop + (mode === 'screen-reader' ? 1 : 0)
  const contentBudget = Math.max(1, limit - projectedChromeRows)
  const sourceRows =
    matchingViewportIndex(viewportIndex, source, width, mode)
      ?.assistantMarkdownRows ??
    assistantMarkdownProjectionRows(sourceText ?? '', width, mode)
  const contentStart = Math.min(
    Math.max(0, startRow - sourceChromeRows + (startRow > 0 ? 1 : 0)),
    sourceRows.length,
  )
  const clippedBefore = contentStart > 0 && contentBudget > 1
  let remaining = Math.max(1, contentBudget - (clippedBefore ? 1 : 0))
  let contentEnd = Math.min(sourceRows.length, contentStart + remaining)
  const clippedAfter = contentEnd < sourceRows.length && remaining > 1
  if (clippedAfter) {
    remaining -= 1
    contentEnd = Math.min(sourceRows.length, contentStart + remaining)
  }
  const selected = sourceRows.slice(contentStart, contentEnd)
  const first = selected[0]
  const last = selected.at(-1)
  const needsSyntheticOpen = clippedBefore && first?.fenceBefore === true
  const needsSyntheticClose = clippedAfter && last?.fenceAfter === true
  const lines = [
    ...(clippedBefore
      ? [
          needsSyntheticOpen
            ? `\`\`\`${first?.fenceLabel || 'code'}`
            : TRANSCRIPT_TRUNCATION_MARKER,
        ]
      : []),
    ...selected.map((row) => row.text),
    ...(clippedAfter
      ? [needsSyntheticClose ? '```' : TRANSCRIPT_TRUNCATION_MARKER]
      : []),
  ]
  const text = lines.join('\n')
  return {
    ...source,
    item: { kind: 'assistant', text },
    viewportSlice: {
      text,
      rows: projectedChromeRows + lines.length,
      assistantMarkdown: { marginTop },
    },
  }
}

function withViewportSlice(
  projected: TranscriptPresentationEntry,
  source: TranscriptPresentationEntry,
  startRow: number,
  budget: number,
  width: number,
  mode: TranscriptPresentationMode,
  viewportIndex?: TranscriptEntryViewportIndex,
): TranscriptPresentationEntry {
  const retainedIndex = matchingViewportIndex(
    viewportIndex,
    source,
    width,
    mode,
  )
  if (
    source.kind === 'item' &&
    source.item.kind === 'assistant' &&
    (retainedIndex?.rows.length ??
      estimateRenderedTranscriptEntryLines(source, width, mode)) > budget
  )
    return projectAssistantMarkdownSlice(
      source,
      retainedIndex ? undefined : source.item.text,
      startRow,
      budget,
      width,
      mode,
      retainedIndex,
    )
  const sourceRows =
    retainedIndex?.rows ?? entryViewportRows(source, width, mode)
  if (!sourceRows || sourceRows.length <= budget) return projected
  const limit = Math.max(1, budget)
  const start = Math.min(
    Math.max(0, startRow + (startRow > 0 ? 1 : 0)),
    Math.max(0, sourceRows.length - 1),
  )
  const clippedBefore = start > 0 && limit > 1
  let remaining = Math.max(1, limit - (clippedBefore ? 1 : 0))
  let end = Math.min(sourceRows.length, start + remaining)
  const clippedAfter = end < sourceRows.length && remaining > 1
  if (clippedAfter) {
    remaining -= 1
    end = Math.min(sourceRows.length, start + remaining)
  }
  const rows = [
    ...(clippedBefore ? [TRANSCRIPT_TRUNCATION_MARKER] : []),
    ...sourceRows.slice(start, end),
    ...(clippedAfter ? [TRANSCRIPT_TRUNCATION_MARKER] : []),
  ]
  return {
    ...projected,
    viewportSlice: { text: rows.join('\n'), rows: rows.length },
  }
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
    budget -
    Math.max(
      0,
      estimateTranscriptEntryLines(withoutValue, viewportWidth, mode) - 1,
    )
  if (remaining <= 0) return withoutValue
  for (let allowed = remaining; allowed >= 1; allowed -= 1) {
    const projected = replace(entry, textTail(value, allowed, contentWidth))
    if (estimateTranscriptEntryLines(projected, viewportWidth, mode) <= budget)
      return projected
  }
  return withoutValue
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

function rangeEntryText<T extends TranscriptPresentationEntry>(
  entry: T,
  value: string,
  replace: (source: T, projectedValue: string) => T,
  startRow: number,
  budget: number,
  viewportWidth: number,
  contentWidth: number,
  mode: TranscriptPresentationMode,
): T {
  if (!value) return entry
  const withoutValue = replace(entry, '')
  // Empty renderer fields still account for one placeholder row. The source
  // content begins before that placeholder, while the two clipping markers
  // occupy the boundary rows of a middle projection.
  const fixedRows = Math.max(
    0,
    estimateTranscriptEntryLines(withoutValue, viewportWidth, mode) - 1,
  )
  const contentStart = Math.max(
    0,
    startRow - fixedRows + (startRow > 0 ? 2 : 0),
  )
  for (
    let contentBudget = Math.max(1, budget - fixedRows);
    contentBudget >= 1;
    contentBudget -= 1
  ) {
    const projected = replace(
      entry,
      textRange(value, contentStart, contentBudget, contentWidth),
    )
    if (estimateTranscriptEntryLines(projected, viewportWidth, mode) <= budget)
      return projected
  }
  return withoutValue
}

function projectOversizedEntryLegacy(
  entry: TranscriptPresentationEntry,
  budget: number,
  width: number,
  mode: TranscriptPresentationMode,
  fromStart = false,
): TranscriptPresentationEntry {
  if (entry.kind === 'item') {
    const item = entry.item
    if (item.kind === 'thinking')
      return {
        ...entry,
        item: {
          ...item,
          text: (fromStart ? textHead : textTail)(
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
          summary: (fromStart ? textHead : textTail)(
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
          text: (fromStart ? textHead : textTail)(
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

function projectOversizedEntry(
  entry: TranscriptPresentationEntry,
  budget: number,
  width: number,
  mode: TranscriptPresentationMode,
  fromStart = false,
): TranscriptPresentationEntry {
  const projected = projectOversizedEntryLegacy(
    entry,
    budget,
    width,
    mode,
    fromStart,
  )
  const rows = entryViewportRows(entry, width, mode)
  if (!rows || rows.length <= budget) return projected
  const visibleRows = Math.max(1, budget)
  const start = fromStart ? 0 : Math.max(0, rows.length - visibleRows)
  return withViewportSlice(projected, entry, start, budget, width, mode)
}

function projectTranscriptEntryRangeLegacy(
  entry: TranscriptPresentationEntry,
  startRow: number,
  budget: number,
  width: number,
  mode: TranscriptPresentationMode,
): TranscriptPresentationEntry {
  if (entry.kind === 'item' && 'text' in entry.item) {
    const item = entry.item
    return rangeEntryText(
      entry,
      item.text,
      (source, text) => ({
        ...source,
        item: { ...source.item, text },
      }),
      startRow,
      budget,
      width,
      item.kind === 'assistant'
        ? mode === 'screen-reader'
          ? Math.max(1, width - 7)
          : markdownContentWidth(width)
        : item.kind === 'user'
          ? Math.max(1, width - (mode === 'screen-reader' ? 5 : 2))
          : Math.max(1, width - (item.kind === 'local-result' ? 4 : 2)),
      mode,
    )
  }
  if (entry.kind === 'item' && entry.item.kind === 'compact')
    return rangeEntryText(
      entry,
      entry.item.summary,
      (source, summary) => ({
        ...source,
        item: { ...source.item, summary },
      }),
      startRow,
      budget,
      width,
      markdownContentWidth(width),
      mode,
    )
  if (entry.kind === 'tool') {
    if (entry.result && entry.item.call.name !== 'Edit') {
      const result = entry.result
      return rangeEntryText(
        entry,
        result.text,
        (source, text) => ({
          ...source,
          result: { ...result, text },
        }),
        startRow,
        budget,
        width,
        Math.max(1, width - 5),
        mode,
      )
    }
    const inputKey = ['command', 'new_string', 'old_string', 'file_path'].find(
      (key) => inputString(entry, key).length > 0,
    )
    if (inputKey)
      return rangeEntryText(
        entry,
        inputString(entry, inputKey),
        (source, value) => replaceToolInput(source, inputKey, value),
        startRow,
        budget,
        width,
        Math.max(1, width - 8),
        mode,
      )
    if (entry.item.detail)
      return rangeEntryText(
        entry,
        entry.item.detail,
        (source, detail) => ({
          ...source,
          item: { ...source.item, detail },
        }),
        startRow,
        budget,
        width,
        Math.max(1, width - 1),
        mode,
      )
  }
  if (entry.kind === 'shell') {
    if (entry.result) {
      const result = entry.result
      const combined = combinedShellOutput(result.stdout, result.stderr)
      return rangeEntryText(
        entry,
        combined,
        (source, stdout) => ({
          ...source,
          result: { ...result, stdout, stderr: '' },
        }),
        startRow,
        budget,
        width,
        Math.max(1, width - 5),
        mode,
      )
    }
    return rangeEntryText(
      entry,
      entry.item.command,
      (source, command) => ({
        ...source,
        item: { ...source.item, command },
      }),
      startRow,
      budget,
      width,
      Math.max(1, width - 4),
      mode,
    )
  }
  if (entry.kind === 'orphan-tool-result')
    return rangeEntryText(
      entry,
      entry.item.text,
      (source, text) => ({
        ...source,
        item: { ...source.item, text },
      }),
      startRow,
      budget,
      width,
      Math.max(1, width - 2),
      mode,
    )
  if (entry.kind === 'orphan-shell-result') {
    const combined = orphanShellOutput(entry.item.stdout, entry.item.stderr)
    return rangeEntryText(
      entry,
      combined,
      (source, stdout) => ({
        ...source,
        item: { ...source.item, stdout, stderr: '' },
      }),
      startRow,
      budget,
      width,
      Math.max(1, width - 2),
      mode,
    )
  }
  return projectOversizedEntry(entry, budget, width, mode)
}

export function projectTranscriptEntryRange(
  entry: TranscriptPresentationEntry,
  startRow: number,
  budget: number,
  width: number,
  mode: TranscriptPresentationMode,
  viewportIndex?: TranscriptEntryViewportIndex,
): TranscriptPresentationEntry {
  const retainedIndex = matchingViewportIndex(viewportIndex, entry, width, mode)
  return withViewportSlice(
    retainedIndex
      ? entry
      : projectTranscriptEntryRangeLegacy(entry, startRow, budget, width, mode),
    entry,
    startRow,
    budget,
    width,
    mode,
    retainedIndex,
  )
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

export function projectTranscriptPresentationRange(
  entries: readonly TranscriptPresentationEntry[],
  budget: number,
  width: number,
  startRow: number,
  mode: TranscriptPresentationMode,
): readonly TranscriptPresentationEntry[] {
  const limit = Math.max(1, budget)
  const totalRows = transcriptPresentationLineCount(entries, width, mode)
  const rangeStart = Math.min(Math.max(0, startRow), totalRows)
  const rangeEnd = Math.min(totalRows, rangeStart + limit)
  const selected: TranscriptPresentationEntry[] = []
  let cursor = 0
  for (const entry of entries) {
    const count = estimateTranscriptEntryLines(entry, width, mode)
    const entryEnd = cursor + count
    const overlapStart = Math.max(rangeStart, cursor)
    const overlapEnd = Math.min(rangeEnd, entryEnd)
    if (overlapStart < overlapEnd) {
      const localStart = overlapStart - cursor
      const overlapRows = overlapEnd - overlapStart
      const projected =
        localStart === 0 && overlapRows === count
          ? entry
          : projectTranscriptEntryRange(
              entry,
              localStart,
              overlapRows,
              width,
              mode,
            )
      if (estimateTranscriptEntryLines(projected, width, mode) <= overlapRows)
        selected.push(projected)
    }
    cursor = entryEnd
    if (cursor >= rangeEnd) break
  }
  return selected
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
  return projectTranscriptPresentationRange(
    entries,
    limit,
    width,
    Math.max(0, totalRows - clampedOffset - limit),
    mode,
  )
}
