import { cloneElement, useEffect, useState, type ReactElement } from 'react'

import { Box, Text, useStdout } from 'ink'

import type { ModelToolCall, ModelUsage } from '../../core/runtime.js'
import type { AgentColorName } from '../../compatibility/claude/agent-color.js'
import { composerEditorSegments } from './composer-editor.js'
import type { TuiFileEntry, TuiMentionEntry } from './file-picker.js'
import { visiblePatchLines, type TuiDiffSnapshot } from './git-diff.js'
import { TUI_HOOK_MENU, type TuiHookConfiguration } from './hook-settings.js'
import type { TuiMemoryFileEntry } from './memory-files.js'
import type { TuiPermissionRule } from './permission-settings.js'
import type { RecentlyDeniedAction } from './recently-denied.js'
import type { CustomThemeToken, TuiCustomTheme } from './custom-themes.js'
import type { TuiSlashCommand } from './slash-commands.js'
import {
  tuiPalette,
  tuiSyntaxStyle,
  useTuiPalette,
  type TuiPalette,
  type TuiSyntaxToken,
  type TuiTheme,
} from './theme.js'
const SPINNER = ['✳', '✢', '✣', '✤', '✥'] as const

export interface TuiDisplayMetadata {
  version: string
  cwd: string
  model?: string
  effort?: string
  permissionMode?: string
  contextWindowTokens?: number
}
export type TranscriptItem =
  | { kind: 'user' | 'assistant' | 'notice' | 'warning'; text: string }
  | { kind: 'local-result'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'compact'; summary: string }
  | {
      kind: 'context'
      usedTokens: number
      contextWindowTokens: number
      model?: string
      skills: readonly { name: string; tokens: number }[]
      memoryFiles: readonly { path: string; tokens: number }[]
    }
  | { kind: 'tool'; call: ModelToolCall; detail: string }
  | {
      kind: 'tool-result'
      callId: string
      text: string
      isError: boolean
    }
  | { kind: 'shell'; callId: string; command: string }
  | {
      kind: 'shell-result'
      callId: string
      stdout: string
      stderr: string
      isError: boolean
    }

export interface TuiBtwEntry {
  id: number
  question: string
  answer: string
  status: 'answering' | 'complete' | 'forking' | 'error'
  error?: string
}

export function useTerminalWidth(override?: number): number {
  const { stdout } = useStdout()
  const [width, setWidth] = useState(override ?? stdout.columns ?? 80)

  useEffect(() => {
    if (override !== undefined) {
      setWidth(override)
      return
    }
    const resize = () => setWidth(stdout.columns ?? 80)
    stdout.on('resize', resize)
    return () => {
      stdout.off('resize', resize)
    }
  }, [override, stdout])

  return Math.max(32, width)
}

export function useTerminalRows(override?: number): number | undefined {
  const { stdout } = useStdout()
  const initialRows = override ?? (stdout.isTTY ? stdout.rows : undefined)
  const [rows, setRows] = useState(initialRows)

  useEffect(() => {
    if (override !== undefined) {
      setRows(override)
      return
    }
    const resize = () => setRows(stdout.rows)
    stdout.on('resize', resize)
    return () => {
      stdout.off('resize', resize)
    }
  }, [override, stdout])

  return rows === undefined ? undefined : Math.max(12, rows)
}

function compactPath(cwd: string): string {
  const home = process.env.HOME
  return home && cwd.startsWith(`${home}/`)
    ? `~/${cwd.slice(home.length + 1)}`
    : cwd
}

function permissionLabel(mode?: string): string {
  switch (mode) {
    case 'acceptEdits':
      return 'accept edits on'
    case 'bypassPermissions':
      return 'bypass permissions on'
    case 'dontAsk':
      return 'dont ask mode'
    case 'plan':
      return 'plan mode'
    case 'auto':
      return 'auto mode'
    default:
      return 'permissions default'
  }
}

function compactPermissionLabel(mode?: string): string {
  switch (mode) {
    case 'acceptEdits':
      return 'accept edits'
    case 'bypassPermissions':
      return 'bypass'
    case 'dontAsk':
      return 'dont ask'
    case 'plan':
      return 'plan'
    case 'auto':
      return 'auto'
    default:
      return 'default'
  }
}

// Width-prioritized composer footer left text. The footer is one deliberate,
// non-wrapping line: mode and the busy/effort state always win, while
// shortcuts/agents/thinking hints are dropped or shortened as width shrinks.
function composerFooterLeft(
  width: number,
  busy: boolean,
  hasThinking: boolean,
  thinkingExpanded: boolean,
  mode: string,
  compactMode: string,
  includeHints = true,
): string {
  const cancelOrShortcut = busy ? 'esc to interrupt' : '? for shortcuts'
  if (!includeHints) {
    if (busy) return `${width >= 60 ? mode : compactMode} · ${cancelOrShortcut}`
    return width >= 60 ? mode : compactMode
  }
  if (width >= 60) {
    let text = `${mode} · ${cancelOrShortcut}`
    if (width >= 80) text += ' · ← for agents'
    if (width >= 100 && hasThinking) {
      text += ` · ctrl+o ${thinkingExpanded ? 'collapse' : 'expand'}`
    }
    return text
  }
  if (busy) return `${compactMode} · ${cancelOrShortcut}`
  return width >= 40 ? mode : compactMode
}

function selectionPrefix(selected: boolean, screenReader: boolean): string {
  if (selected) return screenReader ? 'Selected: ' : '  ❯ '
  return screenReader ? '' : '    '
}

export function WelcomePanel({
  display,
  width,
  showTips,
}: {
  display: TuiDisplayMetadata
  width: number
  showTips: boolean
}) {
  const palette = useTuiPalette()
  if (!showTips) return null
  const panelWidth = Math.min(100, Math.max(32, width))
  const wide = panelWidth >= 72
  const brand = 'Praxis'
  const model = display.model ?? 'provider default'
  const effort = display.effort ? ` · ${display.effort} effort` : ''
  const cwd = compactPath(display.cwd)
  // Title lives in the top border row:
  //   ╭───Praxis Code vX.Y.Z ───...───╮
  // Fixed prefix/suffix = "╭───"(4) + "Praxis"(6) + " Code vX.Y.Z "(8 + version)
  // + "╮"(1), so the fill keeps the row exactly at panelWidth.
  const title = `${brand} Code v${display.version}`
  const fill = Math.max(1, panelWidth - title.length - 6)
  const leftWidth = Math.max(12, Math.floor((panelWidth - 4) / 2))
  const rightWidth = Math.max(12, panelWidth - leftWidth - 4)
  return (
    <Box flexDirection="column" width={panelWidth}>
      <Text color={palette.muted}>
        {'╭───'}
        <Text color={palette.brand} bold>
          {brand}
        </Text>
        {` Code v${display.version} `}
        <Text dimColor>{'─'.repeat(fill)}</Text>
        {'╮'}
      </Text>
      <Box
        borderStyle="round"
        borderColor={palette.muted}
        borderTop={false}
        flexDirection={wide ? 'row' : 'column'}
        width={panelWidth}
        paddingX={1}
      >
        <Box
          alignItems={wide ? 'center' : undefined}
          flexDirection="column"
          width={wide ? leftWidth : '100%'}
        >
          <Text> </Text>
          <Text bold>Welcome to {brand}</Text>
          <Text> </Text>
          <Text color={palette.brand} bold>
            ▐▛███▜▌
          </Text>
          <Text color={palette.brand}>▝▜█████▛▘</Text>
          <Text color={palette.brand}> ▘▘ ▝▝</Text>
          <Text> </Text>
          <Text wrap="truncate-end">
            {model}
            {effort}
          </Text>
          <Text dimColor wrap="truncate-end">
            {cwd}
          </Text>
        </Box>
        <Box
          flexDirection="column"
          width={wide ? rightWidth : '100%'}
          marginTop={wide ? 0 : 1}
        >
          <Text bold>Get started</Text>
          <Text wrap="truncate-end">/init to create CLAUDE.md</Text>
          <Text wrap="truncate-end">/config to open settings</Text>
          <Text dimColor> </Text>
          <Text bold>Shared with Claude Code</Text>
          <Text dimColor wrap="truncate-end">
            Sessions · memory · skills
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

// Compact identity header shown above the transcript once a fresh session has
// conversation content. Keeps the same product/model/cwd facts as WelcomePanel
// in a small fixed footprint, truncating every line to the supplied width.
export function SessionIdentity({
  display,
  width,
}: {
  display: TuiDisplayMetadata
  width: number
}) {
  const palette = useTuiPalette()
  const identityWidth = Math.max(1, Math.floor(width))
  const model = display.model ?? 'provider default'
  const effort = display.effort ? ` · ${display.effort} effort` : ''
  const cwd = compactPath(display.cwd)
  return (
    <Box flexDirection="column" width={identityWidth}>
      <Text wrap="truncate-end">
        <Text color={palette.brand} bold>
          {`Praxis Code v${display.version}`}
        </Text>
      </Text>
      <Text wrap="truncate-end">
        {model}
        {effort}
      </Text>
      <Text dimColor wrap="truncate-end">
        {cwd}
      </Text>
    </Box>
  )
}

interface InlineSegment {
  kind: 'code' | 'bold' | 'link' | 'plain'
  text: string
}

const INLINE_SEGMENT_CACHE_MAX = 4096
const inlineSegmentCache = new Map<string, readonly InlineSegment[]>()

function cachedInlineSegments(text: string): readonly InlineSegment[] {
  const cached = inlineSegmentCache.get(text)
  if (cached) return cached
  const segments = text
    .split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/u)
    .map((token): InlineSegment => {
      if (token.startsWith('`') && token.endsWith('`'))
        return { kind: 'code', text: token.slice(1, -1) }
      if (token.startsWith('**') && token.endsWith('**'))
        return { kind: 'bold', text: token.slice(2, -2) }
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(token)
      if (link) {
        const linkText = link[1]
        if (linkText !== undefined) return { kind: 'link', text: linkText }
      }
      return { kind: 'plain', text: token }
    })
  inlineSegmentCache.set(text, segments)
  if (inlineSegmentCache.size > INLINE_SEGMENT_CACHE_MAX) {
    const oldest = inlineSegmentCache.keys().next().value
    if (oldest !== undefined) inlineSegmentCache.delete(oldest)
  }
  return segments
}

function inlineTextElement(text: string, palette: TuiPalette): ReactElement {
  return (
    <Text>
      {cachedInlineSegments(text).map((segment, index) => {
        if (segment.kind === 'code')
          return (
            <Text key={index} color={palette.info}>
              {segment.text}
            </Text>
          )
        if (segment.kind === 'bold')
          return (
            <Text key={index} bold>
              {segment.text}
            </Text>
          )
        if (segment.kind === 'link')
          return (
            <Text key={index} color={palette.link} underline>
              {segment.text}
            </Text>
          )
        return segment.text
      })}
    </Text>
  )
}

type MarkdownLineShape =
  | { role: 'empty' }
  | { role: 'h1'; content: string }
  | { role: 'h2'; content: string }
  | { role: 'h3'; content: string }
  | { role: 'bullet'; content: string }
  | { role: 'ordered'; content: string }
  | { role: 'quote'; content: string }
  | { role: 'plain'; content: string }

const MARKDOWN_LINE_CACHE_MAX = 4096
const markdownLineCache = new Map<string, MarkdownLineShape>()

function cachedMarkdownLineShape(line: string): MarkdownLineShape {
  const cached = markdownLineCache.get(line)
  if (cached) return cached
  let shape: MarkdownLineShape
  if (line.startsWith('### ')) shape = { role: 'h3', content: line.slice(4) }
  else if (line.startsWith('## '))
    shape = { role: 'h2', content: line.slice(3) }
  else if (line.startsWith('# ')) shape = { role: 'h1', content: line.slice(2) }
  else if (/^[-*] /u.test(line))
    shape = { role: 'bullet', content: line.slice(2) }
  else if (/^\d+\. /u.test(line)) shape = { role: 'ordered', content: line }
  else if (line.startsWith('> '))
    shape = { role: 'quote', content: line.slice(2) }
  else if (line === '') shape = { role: 'empty' }
  else shape = { role: 'plain', content: line }
  markdownLineCache.set(line, shape)
  if (markdownLineCache.size > MARKDOWN_LINE_CACHE_MAX) {
    const oldest = markdownLineCache.keys().next().value
    if (oldest !== undefined) markdownLineCache.delete(oldest)
  }
  return shape
}

const ELEMENT_CACHE_KEY_SEPARATOR = String.fromCharCode(0)

function markdownLineStyleSignature(palette: TuiPalette): string {
  return [palette.accent, palette.brand, palette.info, palette.link].join(
    ELEMENT_CACHE_KEY_SEPARATOR,
  )
}

const MARKDOWN_LINE_ELEMENT_CACHE_MAX = 4096
const markdownLineElementCache = new Map<string, ReactElement>()

function buildMarkdownLine(line: string, palette: TuiPalette): ReactElement {
  const shape = cachedMarkdownLineShape(line)
  if (shape.role === 'h3')
    return <Text bold>{inlineTextElement(shape.content, palette)}</Text>
  if (shape.role === 'h2')
    return (
      <Text bold color={palette.accent}>
        {inlineTextElement(shape.content, palette)}
      </Text>
    )
  if (shape.role === 'h1')
    return (
      <Text bold color={palette.brand}>
        {inlineTextElement(shape.content, palette)}
      </Text>
    )
  if (shape.role === 'bullet')
    return (
      <Text>
        {'  • '}
        {inlineTextElement(shape.content, palette)}
      </Text>
    )
  if (shape.role === 'ordered')
    return (
      <Text>
        {'  '}
        {inlineTextElement(shape.content, palette)}
      </Text>
    )
  if (shape.role === 'quote')
    return (
      <Text dimColor>
        {'│ '}
        {inlineTextElement(shape.content, palette)}
      </Text>
    )
  if (shape.role === 'plain') return inlineTextElement(shape.content, palette)
  return <Text> </Text>
}

function cachedMarkdownLineElement(
  line: string,
  palette: TuiPalette,
): ReactElement {
  const key = [line, markdownLineStyleSignature(palette)].join(
    ELEMENT_CACHE_KEY_SEPARATOR,
  )
  const cached = markdownLineElementCache.get(key)
  if (cached) return cached
  const element = buildMarkdownLine(line, palette)
  markdownLineElementCache.set(key, element)
  if (markdownLineElementCache.size > MARKDOWN_LINE_ELEMENT_CACHE_MAX) {
    const oldest = markdownLineElementCache.keys().next().value
    if (oldest !== undefined) markdownLineElementCache.delete(oldest)
  }
  return element
}

const CODE_KEYWORDS = new Set([
  'async',
  'await',
  'class',
  'const',
  'else',
  'export',
  'false',
  'from',
  'function',
  'if',
  'import',
  'let',
  'new',
  'null',
  'return',
  'true',
  'undefined',
  'var',
])

const CODE_TOKEN_PATTERN =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:async|await|class|const|else|export|false|from|function|if|import|let|new|null|return|true|undefined|var)\b|\b[A-Za-z_$][\w$]*(?=\s*\())/gu

interface CachedSyntaxToken {
  kind: TuiSyntaxToken
  token: string
}

const SYNTAX_TOKEN_CACHE_MAX = 2048
const syntaxTokenCache = new Map<string, readonly CachedSyntaxToken[]>()

function cachedSyntaxTokens(text: string): readonly CachedSyntaxToken[] {
  const cached = syntaxTokenCache.get(text)
  if (cached) return cached
  const tokens = text.split(CODE_TOKEN_PATTERN).map((token) => ({
    kind:
      token.startsWith('"') || token.startsWith("'")
        ? ('string' as const)
        : CODE_KEYWORDS.has(token)
          ? ('keyword' as const)
          : /^[A-Za-z_$][\w$]*$/u.test(token)
            ? ('identifier' as const)
            : ('text' as const),
    token,
  }))
  syntaxTokenCache.set(text, tokens)
  if (syntaxTokenCache.size > SYNTAX_TOKEN_CACHE_MAX) {
    const oldest = syntaxTokenCache.keys().next().value
    if (oldest !== undefined) syntaxTokenCache.delete(oldest)
  }
  return tokens
}

function syntaxStyleSignature(palette: TuiPalette): string {
  const syntax = palette.syntax
  return [
    palette.syntaxHighlightingDisabled ? '1' : '0',
    syntax.text,
    syntax.keyword,
    syntax.identifier,
    syntax.string,
    syntax.removedBackground ?? '',
    syntax.addedBackground ?? '',
  ].join(ELEMENT_CACHE_KEY_SEPARATOR)
}

const SYNTAX_LINE_ELEMENT_CACHE_MAX = 4096
const syntaxLineElementCache = new Map<string, ReactElement>()

function buildSyntaxCodeLine(
  text: string,
  prefix: string,
  change: 'added' | 'removed' | undefined,
  palette: TuiPalette,
): ReactElement {
  if (palette.syntaxHighlightingDisabled) {
    return (
      <Text>
        {prefix}
        {text || ' '}
      </Text>
    )
  }
  const lineStyle = tuiSyntaxStyle(palette, 'text', change)
  return (
    <Text>
      {prefix}
      <Text {...lineStyle}>
        {cachedSyntaxTokens(text).map(({ kind, token }, index) => {
          if (kind === 'text') return token
          return (
            <Text key={index} {...tuiSyntaxStyle(palette, kind)}>
              {token}
            </Text>
          )
        })}
      </Text>
    </Text>
  )
}

function cachedSyntaxCodeLine(
  text: string,
  prefix: string,
  change: 'added' | 'removed' | undefined,
  palette: TuiPalette,
): ReactElement {
  const key = [text, prefix, change ?? '', syntaxStyleSignature(palette)].join(
    ELEMENT_CACHE_KEY_SEPARATOR,
  )
  const cached = syntaxLineElementCache.get(key)
  if (cached) return cached
  const element = buildSyntaxCodeLine(text, prefix, change, palette)
  syntaxLineElementCache.set(key, element)
  if (syntaxLineElementCache.size > SYNTAX_LINE_ELEMENT_CACHE_MAX) {
    const oldest = syntaxLineElementCache.keys().next().value
    if (oldest !== undefined) syntaxLineElementCache.delete(oldest)
  }
  return element
}

function SyntaxCodeLine({
  text,
  prefix = '',
  change,
}: {
  text: string
  prefix?: string
  change?: 'added' | 'removed'
}) {
  const palette = useTuiPalette()
  return cachedSyntaxCodeLine(text, prefix, change, palette)
}

function ToolResultText({
  text,
  prefix = '',
}: {
  text: string
  prefix?: string
}) {
  const palette = useTuiPalette()
  return (
    <Box flexDirection="column">
      {text.split('\n').map((line, index) =>
        line.startsWith('+') && !line.startsWith('+++') ? (
          <SyntaxCodeLine
            key={index}
            prefix={index === 0 ? prefix : prefix ? '   ' : ''}
            text={line}
            change="added"
          />
        ) : line.startsWith('-') && !line.startsWith('---') ? (
          <SyntaxCodeLine
            key={index}
            prefix={index === 0 ? prefix : prefix ? '   ' : ''}
            text={line}
            change="removed"
          />
        ) : (
          <Text
            key={index}
            {...(line.startsWith('@@')
              ? { color: palette.info }
              : { dimColor: true })}
          >
            {index === 0 ? prefix : prefix ? '   ' : ''}
            {line || ' '}
          </Text>
        ),
      )}
    </Box>
  )
}

function inputString(call: ModelToolCall, key: string): string {
  const value = call.input[key]
  return typeof value === 'string' ? value : ''
}

function contentLines(text: string): readonly string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function toolHeading(call: ModelToolCall): string {
  if (call.name === 'Edit') return `Update(${inputString(call, 'file_path')})`
  if (call.name === 'Read') return `Read(${inputString(call, 'file_path')})`
  if (call.name === 'Bash') return `Bash(${inputString(call, 'command')})`
  return call.name
}

function ToolTranscriptEntry({
  call,
  detail,
  result,
  detailed,
}: {
  call: ModelToolCall
  detail: string
  result?: Extract<TranscriptItem, { kind: 'tool-result' }>
  detailed: boolean
}) {
  const palette = useTuiPalette()
  const displayResult =
    call.name === 'Read' &&
    result?.text.startsWith('Wasted call — file unchanged since your last Read')
      ? 'Unchanged since last read'
      : (result?.text ?? '')
  const resultLines = contentLines(displayResult)
  if (call.name === 'Read' && result && !result.isError && !detailed) {
    return (
      <Text>
        {'  '}Read 1 file <Text dimColor>(ctrl+o to expand)</Text>
      </Text>
    )
  }
  const visible = detailed ? resultLines : resultLines.slice(0, 3)
  const hidden = resultLines.length - visible.length
  const resultIsDiff =
    resultLines.some(
      (line) => line.startsWith('+') && !line.startsWith('+++'),
    ) &&
    resultLines.some((line) => line.startsWith('-') && !line.startsWith('---'))
  const errorText =
    displayResult.length > 500
      ? `${displayResult.slice(0, 497)}...`
      : displayResult
  const oldLines = contentLines(inputString(call, 'old_string'))
  const newLines = contentLines(inputString(call, 'new_string'))
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={palette.accent}>⏺</Text>{' '}
        <Text bold>{toolHeading(call)}</Text>
      </Text>
      {!['Bash', 'Read', 'Edit'].includes(call.name) && detail ? (
        <Text dimColor> {detail}</Text>
      ) : null}
      {result ? (
        <Box marginLeft={2} flexDirection="column">
          {result.isError ? (
            <Text color={palette.error}>⎿ Error: {errorText}</Text>
          ) : call.name === 'Edit' ? (
            <>
              <Text dimColor>
                ⎿ Added {newLines.length} line{newLines.length === 1 ? '' : 's'}
                , removed {oldLines.length} line
                {oldLines.length === 1 ? '' : 's'}
              </Text>
              {oldLines.map((line, index) => (
                <SyntaxCodeLine
                  key={`old-${index}`}
                  prefix={`   ${index + 1} -`}
                  text={line}
                  change="removed"
                />
              ))}
              {newLines.map((line, index) => (
                <SyntaxCodeLine
                  key={`new-${index}`}
                  prefix={`   ${index + 1} +`}
                  text={line}
                  change="added"
                />
              ))}
            </>
          ) : resultIsDiff ? (
            <ToolResultText text={visible.join('\n')} prefix="⎿ " />
          ) : (
            <>
              {visible.map((line, index) => (
                <Text key={index} dimColor>
                  {index === 0 ? '⎿ ' : '   '}
                  {line || ' '}
                </Text>
              ))}
              {hidden > 0 ? (
                <Text dimColor>
                  {'   '}… +{hidden} lines (ctrl+o to expand)
                </Text>
              ) : null}
            </>
          )}
        </Box>
      ) : null}
    </Box>
  )
}

function ThinkingBlock({
  text,
  active,
  expanded,
  screenReader,
}: {
  text: string
  active: boolean
  expanded: boolean
  screenReader: boolean
}) {
  const palette = useTuiPalette()
  const summary = text.replace(/\s+/gu, ' ').trim()
  const showFull = screenReader || active || expanded
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text
        {...(!screenReader ? { color: palette.accent } : {})}
        dimColor={!screenReader}
        italic={!screenReader}
      >
        {screenReader ? 'Thinking:' : '✻ '}
        {active ? 'Thinking…' : 'Thought for a moment'}
        {!showFull && summary ? ` · ${summary.slice(0, 160)}` : ''}
      </Text>
      {showFull && text ? (
        <Box marginLeft={screenReader ? 0 : 2} flexDirection="column">
          <MarkdownText text={text} />
        </Box>
      ) : !screenReader && summary.length > 160 ? (
        <Text dimColor> ctrl+o to expand thinking</Text>
      ) : null}
    </Box>
  )
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

function ContextUsageBlock({
  usedTokens,
  contextWindowTokens,
  model,
  skills,
  memoryFiles,
  screenReader,
}: Extract<TranscriptItem, { kind: 'context' }> & { screenReader: boolean }) {
  const totalTokens = Math.max(1, contextWindowTokens)
  const compactBuffer = Math.round(totalTokens * 0.165)
  const usable = Math.max(1, totalTokens - compactBuffer)
  if (screenReader) {
    return (
      <Box flexDirection="column">
        <Text>Context Usage</Text>
        <Text>
          {model ?? 'provider default'} · {usedTokens.toLocaleString()}/
          {totalTokens.toLocaleString()} tokens (
          {percent(usedTokens, totalTokens)})
        </Text>
        <Text>Autocompact buffer: {compactBuffer.toLocaleString()} tokens</Text>
        <Text>
          Skills: {skills.map(({ name }) => name).join(', ') || 'none'}
        </Text>
      </Box>
    )
  }
  const usedCells = Math.min(25, Math.round((usedTokens / totalTokens) * 25))
  const bufferCells = Math.min(
    25 - usedCells,
    Math.round((compactBuffer / totalTokens) * 25),
  )
  const cells = Array.from({ length: 25 }, (_, index) =>
    index < usedCells ? '⛁' : index >= 25 - bufferCells ? '⛝' : '⛶',
  )
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Text bold>Context Usage</Text>
      <Box>
        <Box flexDirection="column" marginRight={2}>
          {Array.from({ length: 5 }, (_, row) => (
            <Text key={row}>{cells.slice(row * 5, row * 5 + 5).join(' ')}</Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text dimColor>
            {model ?? 'provider default'} · {compactTokens(usedTokens)}/
            {compactTokens(totalTokens)} tokens (
            {percent(usedTokens, totalTokens)})
          </Text>
          <Text> </Text>
          <Text dimColor italic>
            Estimated usage by category
          </Text>
          <Text>
            ⛁ Messages and other context: {compactTokens(usedTokens)} tokens (
            {percent(usedTokens, totalTokens)})
          </Text>
          <Text>
            ⛶ Free space: {compactTokens(Math.max(0, usable - usedTokens))} (
            {percent(Math.max(0, usable - usedTokens), totalTokens)})
          </Text>
          <Text>
            ⛝ Autocompact buffer: {compactTokens(compactBuffer)} tokens (
            {percent(compactBuffer, totalTokens)})
          </Text>
        </Box>
      </Box>
      <Text> </Text>
      <Text bold>Memory files · /memory</Text>
      {memoryFiles.length === 0 ? (
        <Text dimColor>└ No memory files</Text>
      ) : (
        memoryFiles.map((file, index) => (
          <Text key={file.path} dimColor>
            {index === memoryFiles.length - 1 ? '└' : '├'} {file.path}:{' '}
            {file.tokens} tokens
          </Text>
        ))
      )}
      <Text> </Text>
      <Text bold>Skills · /skills</Text>
      <Text> </Text>
      <Text>Loaded</Text>
      {skills.length === 0 ? (
        <Text dimColor>└ No skills loaded</Text>
      ) : (
        skills.map((skill, index) => (
          <Text key={skill.name} dimColor>
            {index === skills.length - 1 ? '└' : '├'} {skill.name}: ~
            {skill.tokens} tokens
          </Text>
        ))
      )}
    </Box>
  )
}

type ParsedMarkdownLine =
  | { type: 'fence-open'; label: string }
  | { type: 'fence-close' }
  | { type: 'code'; text: string }
  | { type: 'markdown'; line: string }

const MARKDOWN_TEXT_CACHE_MAX = 2048
const markdownTextCache = new Map<string, readonly ParsedMarkdownLine[]>()

function cachedMarkdownText(text: string): readonly ParsedMarkdownLine[] {
  const cached = markdownTextCache.get(text)
  if (cached) return cached
  const lines = text.split('\n')
  const parsed: ParsedMarkdownLine[] = []
  let code = false
  for (const line of lines) {
    if (line.startsWith('```')) {
      code = !code
      parsed.push(
        code
          ? { type: 'fence-open', label: line.slice(3) || 'code' }
          : { type: 'fence-close' },
      )
      continue
    }
    parsed.push(
      code ? { type: 'code', text: line } : { type: 'markdown', line },
    )
  }
  markdownTextCache.set(text, parsed)
  if (markdownTextCache.size > MARKDOWN_TEXT_CACHE_MAX) {
    const oldest = markdownTextCache.keys().next().value
    if (oldest !== undefined) markdownTextCache.delete(oldest)
  }
  return parsed
}

function markdownTextStyleSignature(palette: TuiPalette): string {
  return [
    syntaxStyleSignature(palette),
    markdownLineStyleSignature(palette),
  ].join(ELEMENT_CACHE_KEY_SEPARATOR)
}

const MARKDOWN_TEXT_ELEMENT_CACHE_MAX = 4096
const markdownTextElementCache = new Map<string, ReactElement>()

function buildMarkdownText(text: string, palette: TuiPalette): ReactElement {
  return (
    <Box flexDirection="column">
      {cachedMarkdownText(text).map((line, index) => {
        if (line.type === 'fence-open')
          return (
            <Text key={index} dimColor>
              {`╭─ ${line.label}`}
            </Text>
          )
        if (line.type === 'fence-close')
          return (
            <Text key={index} dimColor>
              {'╰─'}
            </Text>
          )
        if (line.type === 'code')
          return cloneElement(
            cachedSyntaxCodeLine(line.text, '│ ', undefined, palette),
            { key: index },
          )
        return cloneElement(cachedMarkdownLineElement(line.line, palette), {
          key: index,
        })
      })}
    </Box>
  )
}

function cachedMarkdownTextElement(
  text: string,
  palette: TuiPalette,
): ReactElement {
  const key = [text, markdownTextStyleSignature(palette)].join(
    ELEMENT_CACHE_KEY_SEPARATOR,
  )
  const cached = markdownTextElementCache.get(key)
  if (cached) return cached
  const element = buildMarkdownText(text, palette)
  markdownTextElementCache.set(key, element)
  if (markdownTextElementCache.size > MARKDOWN_TEXT_ELEMENT_CACHE_MAX) {
    const oldest = markdownTextElementCache.keys().next().value
    if (oldest !== undefined) markdownTextElementCache.delete(oldest)
  }
  return element
}

export function MarkdownText({ text }: { text: string }) {
  const palette = useTuiPalette()
  return cachedMarkdownTextElement(text, palette)
}

export function Transcript({
  items,
  activeText,
  activeThinking = '',
  thinkingExpanded = false,
  detailedTranscript = false,
  screenReader,
}: {
  items: readonly TranscriptItem[]
  activeText: string
  activeThinking?: string
  thinkingExpanded?: boolean
  detailedTranscript?: boolean
  screenReader: boolean
}) {
  const palette = useTuiPalette()
  const detailed = thinkingExpanded || detailedTranscript
  const results = new Map(
    items
      .filter(
        (item): item is Extract<TranscriptItem, { kind: 'tool-result' }> =>
          item.kind === 'tool-result',
      )
      .map((item) => [item.callId, item]),
  )
  const pairedResults = new Set(
    items
      .filter(
        (item): item is Extract<TranscriptItem, { kind: 'tool' }> =>
          item.kind === 'tool' && results.has(item.call.id),
      )
      .map((item) => item.call.id),
  )
  const shellResults = new Map(
    items
      .filter(
        (item): item is Extract<TranscriptItem, { kind: 'shell-result' }> =>
          item.kind === 'shell-result',
      )
      .map((item) => [item.callId, item]),
  )
  const pairedShellResults = new Set(
    items
      .filter(
        (item): item is Extract<TranscriptItem, { kind: 'shell' }> =>
          item.kind === 'shell' && shellResults.has(item.callId),
      )
      .map((item) => item.callId),
  )
  const readGroupStarts = new Map<number, number>()
  const groupedReadTools = new Set<number>()
  if (!detailed && !screenReader) {
    for (let index = 0; index < items.length; index += 1) {
      const first = items[index]
      if (first?.kind !== 'tool' || first.call.name !== 'Read') continue
      let cursor = index
      const memberIndexes: number[] = []
      const memberCallIds = new Set<string>()
      while (cursor < items.length) {
        const candidate = items[cursor]
        if (candidate?.kind === 'tool' && candidate.call.name === 'Read') {
          const result = results.get(candidate.call.id)
          if (!result || result.isError) break
          memberIndexes.push(cursor)
          memberCallIds.add(candidate.call.id)
          cursor += 1
          continue
        }
        if (
          candidate?.kind === 'tool-result' &&
          memberCallIds.has(candidate.callId)
        ) {
          cursor += 1
          continue
        }
        break
      }
      if (memberIndexes.length === 0) continue
      readGroupStarts.set(index, memberIndexes.length)
      for (const memberIndex of memberIndexes.slice(1)) {
        groupedReadTools.add(memberIndex)
      }
      index = cursor - 1
    }
  }
  return (
    <Box flexDirection="column">
      {items.map((item, index) => {
        const readCount = readGroupStarts.get(index)
        if (readCount !== undefined) {
          return (
            <Text key={index}>
              {'  '}Read {readCount} file{readCount === 1 ? '' : 's'}{' '}
              <Text dimColor>(ctrl+o to expand)</Text>
            </Text>
          )
        }
        if (groupedReadTools.has(index)) return null
        if (item.kind === 'user') {
          return (
            <Box key={index} marginTop={index === 0 ? 0 : 1}>
              <Text color={palette.brand} bold>
                {screenReader ? 'You: ' : '❯ '}
              </Text>
              <Text bold>{item.text}</Text>
            </Box>
          )
        }
        if (item.kind === 'assistant') {
          return (
            <Box key={index} marginTop={1}>
              {screenReader ? <Text>Praxis:</Text> : null}
              {!screenReader ? <Text color={palette.accent}>⏺ </Text> : null}
              <MarkdownText text={item.text} />
            </Box>
          )
        }
        if (item.kind === 'thinking') {
          return (
            <ThinkingBlock
              key={index}
              text={item.text}
              active={false}
              expanded={detailed}
              screenReader={screenReader}
            />
          )
        }
        if (item.kind === 'compact') {
          return (
            <Box key={index} flexDirection="column" marginTop={1}>
              <Text color={palette.accent} italic>
                {screenReader
                  ? 'Conversation compacted'
                  : '✻ Conversation compacted (ctrl+o for history)'}
              </Text>
              {detailed ? (
                <Box marginLeft={screenReader ? 0 : 2}>
                  <MarkdownText text={item.summary} />
                </Box>
              ) : null}
            </Box>
          )
        }
        if (item.kind === 'context') {
          return (
            <ContextUsageBlock
              key={index}
              {...item}
              screenReader={screenReader}
            />
          )
        }
        if (item.kind === 'tool') {
          const result = results.get(item.call.id)
          return (
            <ToolTranscriptEntry
              key={index}
              call={item.call}
              detail={item.detail}
              {...(result ? { result } : {})}
              detailed={detailed || screenReader}
            />
          )
        }
        if (item.kind === 'tool-result') {
          if (pairedResults.has(item.callId)) return null
          const text =
            item.text.length > 500 ? `${item.text.slice(0, 497)}...` : item.text
          return (
            <Box key={index} marginLeft={2} flexDirection="column">
              <Text color={item.isError ? palette.error : palette.muted}>
                {item.isError ? '└ Error' : '└ Result'}
              </Text>
              {item.isError ? (
                <Text color={palette.error}>{text}</Text>
              ) : (
                <ToolResultText text={text} />
              )}
            </Box>
          )
        }
        if (item.kind === 'shell') {
          const result = shellResults.get(item.callId)
          const output = result
            ? [result.stdout, result.stderr]
                .filter(Boolean)
                .join(
                  result.stdout &&
                    result.stderr &&
                    !result.stdout.endsWith('\n')
                    ? '\n'
                    : '',
                )
            : ''
          const lines = contentLines(output)
          const visible = detailed || screenReader ? lines : lines.slice(0, 3)
          const hidden = lines.length - visible.length
          return (
            <Box key={index} flexDirection="column" marginTop={1}>
              <Text>
                <Text bold>
                  {screenReader ? 'Shell command: ' : '! '}
                  {item.command}
                </Text>
              </Text>
              {result ? (
                <Box marginLeft={2} flexDirection="column">
                  {lines.length === 0 ? (
                    <Text dimColor>⎿ </Text>
                  ) : (
                    visible.map((line, lineIndex) => (
                      <Text
                        key={lineIndex}
                        {...(result.isError ? { color: palette.error } : {})}
                        dimColor={!result.isError}
                      >
                        {lineIndex === 0 ? '⎿ ' : '   '}
                        {line || ' '}
                      </Text>
                    ))
                  )}
                  {hidden > 0 ? (
                    <Text dimColor>
                      {'   '}… +{hidden} lines (ctrl+o to expand)
                    </Text>
                  ) : null}
                </Box>
              ) : null}
            </Box>
          )
        }
        if (item.kind === 'shell-result') {
          if (pairedShellResults.has(item.callId)) return null
          const output = [item.stdout, item.stderr].filter(Boolean).join('\n')
          return (
            <Text
              key={index}
              {...(item.isError ? { color: palette.error } : {})}
            >
              ⎿ {output}
            </Text>
          )
        }
        if (item.kind === 'local-result') {
          return (
            <Box key={index} marginLeft={2}>
              <Text dimColor>⎿ {item.text}</Text>
            </Box>
          )
        }
        return (
          <Text
            key={index}
            {...(item.kind === 'warning' ? { color: palette.error } : {})}
            dimColor={item.kind === 'notice'}
          >
            {item.kind === 'warning' ? '⚠ ' : '· '}
            {item.text}
          </Text>
        )
      })}
      {activeThinking ? (
        <ThinkingBlock
          text={activeThinking}
          active
          expanded={detailed}
          screenReader={screenReader}
        />
      ) : activeText ? (
        <Box marginTop={1}>
          {screenReader ? (
            <Text>Praxis: </Text>
          ) : (
            <Text color={palette.accent}>✳ </Text>
          )}
          <MarkdownText text={activeText} />
        </Box>
      ) : null}
    </Box>
  )
}

export function DiffDashboard({
  snapshots,
  sourceIndex,
  selectedIndex,
  viewingFile,
  scrollOffset,
  width,
  screenReader,
}: {
  snapshots: readonly { label: string; snapshot: TuiDiffSnapshot }[]
  sourceIndex: number
  selectedIndex: number
  viewingFile: boolean
  scrollOffset: number
  width: number
  screenReader: boolean
}) {
  const palette = useTuiPalette()
  const source = snapshots[sourceIndex]
  const snapshot = source?.snapshot ?? { files: [], additions: 0, deletions: 0 }
  const selected = snapshot.files[selectedIndex]
  const panelWidth = Math.max(32, Math.min(100, width))
  const line = '─'.repeat(panelWidth)
  if (viewingFile && selected) {
    const lines = visiblePatchLines(selected.patch).slice(
      scrollOffset,
      scrollOffset + 18,
    )
    return (
      <Box flexDirection="column">
        {!screenReader ? <Text dimColor>{line}</Text> : null}
        <Text bold> Uncommitted changes (git diff HEAD)</Text>
        <Text>
          {'  '}
          {snapshots.map((item, index) => (
            <Text
              key={item.label}
              inverse={!screenReader && index === sourceIndex}
            >
              {screenReader && index === sourceIndex ? 'Current source: ' : ' '}
              {item.label}{' '}
            </Text>
          ))}
        </Text>
        <Text> </Text>
        <Text bold> {selected.path}</Text>
        {!screenReader ? (
          <Text dimColor> {'─'.repeat(Math.max(1, panelWidth - 4))}</Text>
        ) : null}
        {lines.map((patchLine, index) =>
          patchLine.startsWith('+') && !patchLine.startsWith('+++') ? (
            <SyntaxCodeLine
              key={`${scrollOffset}-${index}`}
              prefix="  "
              text={patchLine}
              change="added"
            />
          ) : patchLine.startsWith('-') && !patchLine.startsWith('---') ? (
            <SyntaxCodeLine
              key={`${scrollOffset}-${index}`}
              prefix="  "
              text={patchLine}
              change="removed"
            />
          ) : (
            <Text key={`${scrollOffset}-${index}`} dimColor>
              {'  '}
              {patchLine}
            </Text>
          ),
        )}
        <Text dimColor> ↑/↓ to scroll · Esc to back</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {!screenReader ? <Text dimColor>{line}</Text> : null}
      <Text bold> Uncommitted changes (git diff HEAD)</Text>
      <Text> </Text>
      <Text>
        {'  '}
        {snapshots.map((item, index) => (
          <Text
            key={item.label}
            inverse={!screenReader && index === sourceIndex}
          >
            {screenReader && index === sourceIndex ? 'Current source: ' : ' '}
            {item.label}{' '}
          </Text>
        ))}
      </Text>
      <Text> </Text>
      <Text>
        {'  '}
        {snapshot.files.length} file{snapshot.files.length === 1 ? '' : 's'}{' '}
        changed <Text color={palette.success}>+{snapshot.additions}</Text>{' '}
        <Text color={palette.error}>-{snapshot.deletions}</Text>
      </Text>
      <Text> </Text>
      {snapshot.files.length === 0 ? (
        <Text dimColor> No uncommitted changes.</Text>
      ) : (
        snapshot.files.map((file, index) => (
          <Text
            key={file.path}
            inverse={!screenReader && index === selectedIndex}
          >
            {selectionPrefix(index === selectedIndex, screenReader)}
            {file.path}{' '}
            <Text {...(!screenReader ? { color: palette.success } : {})}>
              +{file.additions}
            </Text>{' '}
            <Text {...(!screenReader ? { color: palette.error } : {})}>
              -{file.deletions}
            </Text>
          </Text>
        ))
      )}
      <Text> </Text>
      <Text dimColor>
        ←/→ to switch source · ↑/↓ to select · Enter to view · Esc to close
      </Text>
    </Box>
  )
}

export function PermissionDashboard({
  tabIndex,
  selectedIndex,
  query,
  rules,
  recentDenied,
  retryingDeniedId,
  workspaceDirectories,
  width,
  screenReader,
}: {
  tabIndex: number
  selectedIndex: number
  query: string
  rules: readonly TuiPermissionRule[]
  recentDenied: readonly RecentlyDeniedAction[]
  retryingDeniedId?: string | null
  workspaceDirectories: readonly { path: string; original: boolean }[]
  width: number
  screenReader: boolean
}) {
  const tabs = ['Recently denied', 'Allow', 'Ask', 'Deny', 'Workspace'] as const
  const behavior = (['allow', 'ask', 'deny'] as const)[tabIndex - 1]
  const normalizedQuery = query.trim().toLowerCase()
  const matchingRules = behavior
    ? rules.filter(
        (rule) =>
          rule.behavior === behavior &&
          (!normalizedQuery ||
            rule.rule.toLowerCase().includes(normalizedQuery) ||
            rule.scope.includes(normalizedQuery)),
      )
    : []
  const rows = matchingRules.map((rule) => rule.rule)
  const originalWorkspace = workspaceDirectories.find(
    (directory) => directory.original,
  )
  const additionalWorkspaces = workspaceDirectories.filter(
    (directory) => !directory.original,
  )
  const description =
    tabIndex === 0
      ? recentDenied.length === 0
        ? 'No recent denials. Commands denied by the auto mode classifier will appear here.'
        : 'Commands recently denied by the auto mode classifier.'
      : tabIndex === 1
        ? "Praxis Code won't ask before using allowed tools."
        : tabIndex === 2
          ? 'Praxis Code will always ask for confirmation before using these tools.'
          : tabIndex === 3
            ? 'Praxis Code will reject requests to use denied tools.'
            : 'Praxis Code can read files in the workspace, and make edits when auto-accept edits is on.'
  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      {!screenReader ? (
        <Text dimColor>{'─'.repeat(Math.min(100, width))}</Text>
      ) : null}
      <Text bold> Permissions</Text>
      <Text>
        {'  '}
        {tabs.map((tab, index) => (
          <Text key={tab} inverse={!screenReader && index === tabIndex}>
            {screenReader && index === tabIndex ? 'Current tab: ' : ' '}
            {tab}{' '}
          </Text>
        ))}
      </Text>
      <Text> </Text>
      <Text> {description}</Text>
      {tabIndex >= 1 && tabIndex <= 3 ? (
        <Box
          borderStyle={screenReader ? undefined : 'round'}
          paddingX={1}
          marginY={1}
        >
          <Text {...(query ? {} : { dimColor: true })}>
            {screenReader ? 'Search: ' : '⌕ '}
            {query || 'Search…'}
          </Text>
        </Box>
      ) : (
        <Text> </Text>
      )}
      {tabIndex >= 1 && tabIndex <= 3 ? (
        ['Add a new rule…', ...rows].map((row, index) => (
          <Text
            key={`${index}-${row}`}
            inverse={!screenReader && index === selectedIndex}
          >
            {selectionPrefix(index === selectedIndex, screenReader)}
            {index + 1}. {row}
          </Text>
        ))
      ) : tabIndex === 0 ? (
        recentDenied.map((action, index) => (
          <Text
            key={action.id}
            inverse={!screenReader && index === selectedIndex}
          >
            {selectionPrefix(index === selectedIndex, screenReader)}
            {index + 1}. {action.id === retryingDeniedId ? '✔' : '✘'}{' '}
            {action.display}
            {action.id === retryingDeniedId ? ' (retry)' : ''}
            {action.reason ? `  ${action.reason}` : ''}
          </Text>
        ))
      ) : tabIndex === 4 ? (
        <>
          {originalWorkspace ? (
            <Text>
              {'    -  '}
              {originalWorkspace.path} (Original working directory)
            </Text>
          ) : null}
          {additionalWorkspaces.map((directory, index) => (
            <Text
              key={directory.path}
              inverse={!screenReader && selectedIndex === index}
            >
              {selectionPrefix(selectedIndex === index, screenReader)}
              {index + 1}. {directory.path}
            </Text>
          ))}
          <Text
            inverse={
              !screenReader && selectedIndex === additionalWorkspaces.length
            }
          >
            {selectionPrefix(
              selectedIndex === additionalWorkspaces.length,
              screenReader,
            )}
            {additionalWorkspaces.length + 1}. Add directory…
          </Text>
        </>
      ) : rows.length > 0 ? (
        rows.map((row, index) => (
          <Text
            key={`${index}-${row}`}
            inverse={!screenReader && index === selectedIndex}
          >
            {selectionPrefix(index === selectedIndex, screenReader)}
            {index + 1}. {row}
          </Text>
        ))
      ) : null}
      <Text> </Text>
      <Text dimColor>
        {tabIndex === 0 && recentDenied.length > 0
          ? 'Enter to approve · r to retry · ↑/↓ to navigate · Esc to cancel'
          : selectedIndex >= 0
            ? '↑/↓ navigate · Enter to select · ←/→ to switch · Esc to cancel'
            : '←/→ to switch · ↓ to select · Esc to cancel'}
      </Text>
    </Box>
  )
}

const THEME_OPTIONS: readonly { theme: TuiTheme; label: string }[] = [
  { theme: 'auto', label: 'Auto (match terminal)' },
  { theme: 'dark', label: 'Dark mode' },
  { theme: 'light', label: 'Light mode' },
  { theme: 'dark-daltonized', label: 'Dark mode (colorblind-friendly)' },
  { theme: 'light-daltonized', label: 'Light mode (colorblind-friendly)' },
  { theme: 'dark-ansi', label: 'Dark mode (ANSI colors only)' },
  { theme: 'light-ansi', label: 'Light mode (ANSI colors only)' },
]

export function ThemePicker({
  currentTheme,
  selectedIndex,
  syntaxHighlightingDisabled,
  customThemes = [],
  allowCustomThemes = true,
  width,
  screenReader,
}: {
  currentTheme: TuiTheme | `custom:${string}`
  selectedIndex: number
  syntaxHighlightingDisabled: boolean
  customThemes?: readonly TuiCustomTheme[]
  allowCustomThemes?: boolean
  width: number
  screenReader: boolean
}) {
  const options = [
    ...THEME_OPTIONS.map((option) => ({ ...option, customTheme: undefined })),
    ...customThemes.map((theme) => ({
      theme: `custom:${theme.slug}` as const,
      label: `${theme.name} (custom)`,
      customTheme: theme,
    })),
    ...(allowCustomThemes
      ? [{ theme: '__new__' as const, label: 'New custom theme…' }]
      : []),
  ]
  const selected = options[selectedIndex]
  const selectedCustomTheme =
    selected && 'customTheme' in selected ? selected.customTheme : undefined
  const previewTheme =
    selected?.theme.startsWith('custom:') && selectedCustomTheme
      ? selectedCustomTheme.base
      : selected?.theme === '__new__'
        ? 'dark'
        : (selected?.theme ??
          (currentTheme.startsWith('custom:') ? 'dark' : currentTheme))
  const preview = tuiPalette(
    previewTheme as TuiTheme,
    syntaxHighlightingDisabled,
    process.env,
    selectedCustomTheme,
  )
  const syntax = preview.syntax
  const syntaxColor = (color: string) =>
    syntaxHighlightingDisabled ? {} : { color }
  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      {!screenReader ? <Text>{'▔'.repeat(Math.min(100, width))}</Text> : null}
      <Text bold> Theme</Text>
      <Text> </Text>
      <Text> Choose the text style that looks best with your terminal</Text>
      <Text> </Text>
      {options.map((option, index) =>
        screenReader ? (
          <Text key={option.theme}>
            {index + 1}. {option.label}
            {option.theme === currentTheme ? ' (current)' : ''}
            {index === selectedIndex ? ' (focused)' : ''}
          </Text>
        ) : (
          <Text key={option.theme} inverse={index === selectedIndex}>
            {index === selectedIndex ? ' ❯ ' : '   '}
            {index + 1}. {option.label}
            {option.theme === currentTheme ? ' ✔' : ''}
          </Text>
        ),
      )}
      <Text> </Text>
      {screenReader ? (
        <Text>Selected: {options[selectedIndex]?.label}</Text>
      ) : null}
      {!screenReader ? (
        <>
          <Text dimColor>
            {' '}
            {'╌'.repeat(Math.max(1, Math.min(96, width - 3)))}
          </Text>
          <Text>
            <Text dimColor> 1 </Text>
            <Text {...syntaxColor(syntax.keyword)}>function</Text>
            <Text {...syntaxColor(syntax.text)}> </Text>
            <Text {...syntaxColor(syntax.identifier)}>greet</Text>
            <Text {...syntaxColor(syntax.text)}>() {'{'}</Text>
          </Text>
          <Text>
            <Text dimColor> 2 - </Text>
            <Text
              {...syntaxColor(syntax.text)}
              {...(syntaxHighlightingDisabled || !syntax.removedBackground
                ? {}
                : { backgroundColor: syntax.removedBackground })}
            >
              {' console.log("Hello, World!"); '}
            </Text>
          </Text>
          <Text>
            <Text dimColor> 2 + </Text>
            <Text
              {...syntaxColor(syntax.text)}
              {...(syntaxHighlightingDisabled || !syntax.addedBackground
                ? {}
                : { backgroundColor: syntax.addedBackground })}
            >
              {' console.'}
              <Text {...syntaxColor(syntax.identifier)}>log</Text>
              {'('}
              <Text {...syntaxColor(syntax.string)}>&quot;Hello, </Text>
              <Text
                {...(syntaxHighlightingDisabled || !syntax.addedHighlight
                  ? {}
                  : { backgroundColor: syntax.addedHighlight })}
              >
                Claude
              </Text>
              <Text {...syntaxColor(syntax.string)}>!&quot;</Text>
              {'); '}
            </Text>
          </Text>
          <Text>
            <Text dimColor> 3 </Text>
            <Text {...syntaxColor(syntax.text)}>{'}'}</Text>
          </Text>
          <Text dimColor>
            {' '}
            {'╌'.repeat(Math.max(1, Math.min(96, width - 3)))}
          </Text>
        </>
      ) : null}
      <Text dimColor>
        {' '}
        {selected?.theme === '__new__'
          ? 'Enter to create a custom theme'
          : syntaxHighlightingDisabled
            ? 'Syntax highlighting disabled (ctrl+t to enable)'
            : `Syntax theme: ${preview.syntaxTheme} (ctrl+t to disable)`}
      </Text>
      <Text dimColor> Enter to select · Esc to cancel</Text>
    </Box>
  )
}

export function CustomThemeEditor({
  theme,
  token,
  value,
  tokens = [],
  selectedIndex = 0,
  query = '',
  width,
  screenReader,
}: {
  theme: TuiCustomTheme
  token?: CustomThemeToken
  value: string
  tokens?: readonly CustomThemeToken[]
  selectedIndex?: number
  query?: string
  width: number
  screenReader: boolean
}) {
  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      <Text bold>{theme.name}</Text>
      {token ? (
        <>
          <Text> </Text>
          <Text>██ {token}</Text>
          <Text dimColor>preset: {value || '(not customized)'}</Text>
          <Text> </Text>
          <Text>Value: {value}</Text>
          <Text dimColor>
            Accepts rgb(r,g,b), #rrggbb, ansi256(n), or ansi:name
          </Text>
          <Text dimColor>Enter to save · Esc to cancel</Text>
        </>
      ) : (
        <>
          <Text dimColor>⌕ {query || 'Filter color tokens…'}</Text>
          {tokens
            .slice(selectedIndex, selectedIndex + 8)
            .map((entry, index) => (
              <Text key={entry} inverse={index === 0}>
                {index === 0 ? '❯ ' : '  '}██ {entry}
                {theme.overrides[entry] === undefined ? '' : ' (custom)'}
              </Text>
            ))}
          <Text dimColor>
            ↑/↓ to nav · Enter to edit · Tab to reset · Esc to done
          </Text>
        </>
      )}
      {screenReader ? <Text>Editing custom theme token</Text> : null}
    </Box>
  )
}

export function ListDashboard({
  title,
  rows,
  emptyText,
  selectedIndex,
  width,
  screenReader,
}: {
  title: string
  rows: readonly { label: string; description?: string }[]
  emptyText: string
  selectedIndex: number
  width: number
  screenReader: boolean
}) {
  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      {!screenReader ? (
        <Text dimColor>{'─'.repeat(Math.min(100, width))}</Text>
      ) : null}
      <Text bold> {title}</Text>
      <Text> </Text>
      {rows.length === 0 ? (
        <Text dimColor> {emptyText}</Text>
      ) : (
        rows.map((row, index) => (
          <Box key={`${index}-${row.label}`} flexDirection="column">
            <Text inverse={index === selectedIndex}>
              {index === selectedIndex ? '❯ ' : '  '}
              {row.label}
            </Text>
            {row.description ? <Text dimColor> {row.description}</Text> : null}
          </Box>
        ))
      )}
      <Text> </Text>
      <Text dimColor>↑/↓ to select · Esc to close</Text>
    </Box>
  )
}

export function MemoryDashboard({
  autoMemoryEnabled,
  entries,
  selectedIndex,
  openedIndex,
  loading = false,
  width,
  screenReader,
}: {
  autoMemoryEnabled: boolean
  entries: readonly TuiMemoryFileEntry[]
  selectedIndex: number
  openedIndex: number | null
  loading?: boolean
  width: number
  screenReader: boolean
}) {
  const palette = useTuiPalette()
  const panelWidth = Math.min(100, width)
  return (
    <Box flexDirection="column" width={panelWidth}>
      {!screenReader ? (
        <Text color={palette.accent}>{'─'.repeat(panelWidth)}</Text>
      ) : null}
      <Text bold> Memory</Text>
      <Text> </Text>
      {loading ? (
        <Text dimColor> ✶ Loading memory files…</Text>
      ) : (
        <>
          <Text> Auto-memory: {autoMemoryEnabled ? 'on' : 'off'}</Text>
          <Text> </Text>
          {entries.map((entry, index) => (
            <Box key={`${entry.kind}-${entry.path}`}>
              <Box width={Math.max(24, Math.min(52, panelWidth - 28))}>
                <Text inverse={index === selectedIndex}>
                  {index === selectedIndex ? '❯ ' : '  '}
                  {index + 1}. {entry.label}
                  {openedIndex === index ? ' ✔' : ''}
                </Text>
              </Box>
              {entry.annotation ? (
                <Text dimColor>{entry.annotation}</Text>
              ) : null}
            </Box>
          ))}
        </>
      )}
      <Text> </Text>
      <Text dimColor> Learn more: https://code.claude.com/docs/en/memory</Text>
      <Text> </Text>
      <Text dimColor italic>
        Enter to confirm · Esc to cancel
      </Text>
    </Box>
  )
}

function selectedWindow(length: number, selectedIndex: number, size: number) {
  return Math.max(
    0,
    Math.min(selectedIndex - Math.floor(size / 2), Math.max(0, length - size)),
  )
}

export function HookDashboard({
  configuration,
  depth,
  eventIndex,
  matcherIndex,
  hookIndex,
  width,
  screenReader,
}: {
  configuration: TuiHookConfiguration
  depth: 'events' | 'matchers' | 'hooks' | 'detail'
  eventIndex: number
  matcherIndex: number
  hookIndex: number
  width: number
  screenReader: boolean
}) {
  const event = configuration.events[eventIndex]
  const matcher = event?.matchers[matcherIndex]
  const hook = matcher?.hooks[hookIndex]
  if (depth === 'detail') {
    return (
      <Box flexDirection="column" width={Math.min(100, width)}>
        {!screenReader ? (
          <Text dimColor>{'─'.repeat(Math.max(12, Math.min(100, width)))}</Text>
        ) : null}
        <Text bold> Hook details</Text>
        <Text> Event: {event?.name ?? 'Hooks'}</Text>
        <Text> Matcher: {matcher?.matcher ?? '(all)'}</Text>
        <Text> Type: {hook?.type ?? 'command'}</Text>
        <Text> Source: {hook?.scopeLabel ?? 'Settings'}</Text>
        <Text> </Text>
        <Text> {hook?.label ?? ''}</Text>
        <Text> </Text>
        <Text dimColor>Esc to go back</Text>
      </Box>
    )
  }
  const rows =
    depth === 'events'
      ? configuration.events
      : depth === 'matchers'
        ? (event?.matchers ?? [])
        : (matcher?.hooks ?? [])
  const selectedIndex =
    depth === 'events'
      ? eventIndex
      : depth === 'matchers'
        ? matcherIndex
        : hookIndex
  const maxVisible = depth === 'events' ? TUI_HOOK_MENU.visibleRows : 7
  const start = selectedWindow(rows.length, selectedIndex, maxVisible)
  const visible = rows.slice(start, start + maxVisible)
  const line = '─'.repeat(Math.max(12, Math.min(100, width)))

  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      {!screenReader ? <Text dimColor>{line}</Text> : null}
      <Text bold>
        {' '}
        {depth === 'events'
          ? TUI_HOOK_MENU.title
          : depth === 'matchers'
            ? `${event?.name ?? 'Hooks'} - Matchers`
            : `${event?.name ?? 'Hooks'} - Matcher: ${matcher?.matcher ?? '(all)'}`}
      </Text>
      {depth === 'events' ? (
        <>
          <Text> {configuration.hookCount} hooks configured</Text>
          <Text> </Text>
          <Text>
            {' '}
            {' ℹ '}
            {TUI_HOOK_MENU.readOnlyNotice}
          </Text>
          <Text dimColor> Learn more</Text>
          <Text> </Text>
        </>
      ) : (
        <>
          {(event?.detail ?? []).map((detail) => (
            <Text key={detail}> {detail}</Text>
          ))}
          <Text> </Text>
        </>
      )}
      {start > 0 ? <Text dimColor> ↑ {start} more above</Text> : null}
      {visible.length === 0 ? (
        <>
          <Text dimColor>
            {' '}
            {depth === 'matchers'
              ? 'No hooks configured for this event'
              : 'No hooks configured for this matcher'}
          </Text>
          {depth === 'matchers' ? (
            <Text dimColor>
              {' '}
              To add hooks, edit settings.json directly or ask Claude
            </Text>
          ) : null}
        </>
      ) : (
        visible.map((row, visibleIndex) => {
          const index = start + visibleIndex
          const selected = index === selectedIndex
          if (depth === 'events') {
            const item = row as TuiHookConfiguration['events'][number]
            return (
              <Box key={item.name}>
                <Box width={30}>
                  <Text inverse={!screenReader && selected}>
                    {screenReader && selected
                      ? 'Selected: '
                      : selected
                        ? '❯ '
                        : '  '}
                    {index + 1}. {item.name}
                    {item.matchers.length > 0
                      ? ` (${item.matchers.reduce((count, current) => count + current.hooks.length, 0)})`
                      : ''}
                  </Text>
                </Box>
                <Text dimColor>{item.description}</Text>
              </Box>
            )
          }
          if (depth === 'matchers') {
            const item = row as NonNullable<typeof event>['matchers'][number]
            return (
              <Text
                key={`${item.scope}-${item.matcher}-${index}`}
                inverse={!screenReader && selected}
              >
                {screenReader && selected
                  ? 'Selected: '
                  : selected
                    ? '❯ '
                    : '  '}
                {index + 1}. [{item.scope}] {item.matcher} {item.hooks.length}{' '}
                {item.hooks.length === 1 ? 'hook' : 'hooks'}
              </Text>
            )
          }
          const item = row as NonNullable<typeof matcher>['hooks'][number]
          return (
            <Box key={`${item.path}-${index}`}>
              <Box flexGrow={1}>
                <Text inverse={!screenReader && selected} wrap="truncate-end">
                  {screenReader && selected
                    ? 'Selected: '
                    : selected
                      ? '❯ '
                      : '  '}
                  {index + 1}. [{item.type}] {item.label}
                </Text>
              </Box>
              <Text dimColor> {item.scopeLabel}</Text>
            </Box>
          )
        })
      )}
      {start + visible.length < rows.length ? (
        <Text dimColor>
          {' '}
          ↓ {rows.length - start - visible.length} more below
        </Text>
      ) : null}
      <Text> </Text>
      <Text dimColor>
        {depth === 'hooks' || rows.length === 0
          ? 'Esc to go back'
          : 'Enter to confirm · Esc to cancel'}
      </Text>
    </Box>
  )
}

export function BtwPanel({
  entries,
  selectedIndex,
  scrollOffset,
  copied,
  width,
  screenReader,
}: {
  entries: readonly TuiBtwEntry[]
  selectedIndex: number
  scrollOffset: number
  copied: boolean
  width: number
  screenReader: boolean
}) {
  const palette = useTuiPalette()
  const selected = entries[selectedIndex]
  const lines = selected?.answer.split('\n') ?? []
  const visibleLines = lines.slice(scrollOffset, scrollOffset + 16)
  const hasHistory = entries.length > 1
  const complete = selected?.status === 'complete'
  const footer = hasHistory
    ? [
        '←/→ to switch',
        ...(complete
          ? [copied ? 'Copied to clipboard' : 'c to copy', 'f to fork']
          : []),
        'x to clear history',
        'Esc to close',
      ].join(' · ')
    : [
        '↑/↓ to scroll',
        ...(complete
          ? [copied ? 'Copied to clipboard' : 'c to copy', 'f to fork']
          : []),
        'Esc to close',
      ].join(' · ')
  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      {!screenReader ? (
        <Text dimColor>{'─'.repeat(Math.min(100, width))}</Text>
      ) : null}
      {entries.map((entry, index) => (
        <Text key={entry.id} dimColor={index !== selectedIndex}>
          {'  '}/btw {entry.question}
        </Text>
      ))}
      <Text> </Text>
      {selected?.status === 'answering' ? (
        <Box flexDirection="column">
          <Text> {'  '}· Answering…</Text>
          {selected.answer
            ? visibleLines.map((line, index) => (
                <Text key={`${scrollOffset + index}-${line}`}>
                  {' '}
                  {'  '}
                  {line || ' '}
                </Text>
              ))
            : null}
        </Box>
      ) : selected?.status === 'forking' ? (
        <Text> {'  '}· Forking…</Text>
      ) : selected?.status === 'error' ? (
        <Text color={palette.error}>
          {' '}
          {'  '}
          {selected.error ?? 'Side question failed'}
        </Text>
      ) : (
        visibleLines.map((line, index) => (
          <Text key={`${scrollOffset + index}-${line}`}>
            {' '}
            {'  '}
            {line || ' '}
          </Text>
        ))
      )}
      <Text> </Text>
      <Text dimColor> {footer}</Text>
    </Box>
  )
}

export function SessionPicker({
  sessions,
  selectedIndex,
  screenReader,
  query = '',
}: {
  sessions: readonly (null | {
    sessionId: string
    name?: string | null
    lastPrompt?: string | null
    status: string
  })[]
  selectedIndex: number
  screenReader: boolean
  query?: string
}) {
  const palette = useTuiPalette()
  const maxVisible = 8
  const start = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(maxVisible / 2),
      sessions.length - maxVisible,
    ),
  )
  const visible = sessions.slice(start, start + maxVisible)
  return (
    <Box flexDirection="column">
      {!screenReader ? <Text dimColor>{'─'.repeat(80)}</Text> : null}
      <Text bold> Resume session</Text>
      <Box
        borderStyle={screenReader ? undefined : 'round'}
        borderColor={palette.muted}
        paddingX={screenReader ? 0 : 1}
        marginY={1}
      >
        <Text {...(query ? {} : { dimColor: true })}>
          ⌕ {query || 'Search…'}
        </Text>
      </Box>
      {start > 0 ? <Text dimColor> ↑ {start} earlier</Text> : null}
      {visible.length === 0 ? <Text dimColor>No sessions found.</Text> : null}
      {visible.map((session, visibleIndex) => {
        const index = start + visibleIndex
        return (
          <Box key={session?.sessionId ?? 'new'}>
            <Text
              {...(index === selectedIndex ? { color: palette.brand } : {})}
              bold={index === selectedIndex}
            >
              {index === selectedIndex ? '❯ ' : '  '}
              {session
                ? (session.name ?? session.lastPrompt ?? 'Untitled')
                : 'Start a new session'}
            </Text>
            {session ? (
              <Text dimColor>
                {' '}
                · {session.sessionId} · {session.status}
              </Text>
            ) : null}
          </Box>
        )
      })}
      {start + visible.length < sessions.length ? (
        <Text dimColor> ↓ {sessions.length - start - visible.length} more</Text>
      ) : null}
      {!screenReader ? (
        <Text dimColor>
          ↑/↓ to navigate · Enter to select · Type to search · Esc to cancel
        </Text>
      ) : null}
    </Box>
  )
}

export function CommandPalette({
  commands,
  selectedIndex,
  width,
  screenReader,
}: {
  commands: readonly TuiSlashCommand[]
  selectedIndex: number
  width: number
  screenReader: boolean
}) {
  const palette = useTuiPalette()
  const paletteWidth = Math.max(1, Math.min(100, width))
  const nameWidth = Math.min(30, paletteWidth)
  const descriptionWidth = Math.max(0, paletteWidth - nameWidth)
  const maxVisible = 12
  const start = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(maxVisible / 2),
      Math.max(0, commands.length - maxVisible),
    ),
  )
  const visible = commands.slice(start, start + maxVisible)
  if (screenReader) {
    return (
      <Box flexDirection="column">
        <Text>Commands</Text>
        {visible.length === 0 ? (
          <Text>No matching commands.</Text>
        ) : (
          visible.map((command) => (
            <Text key={command.name}>
              /{command.name}: {command.description}
            </Text>
          ))
        )}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" width={paletteWidth}>
      {visible.length === 0 ? (
        <Text dimColor>No matching commands.</Text>
      ) : (
        visible.map((command, visibleIndex) => {
          const index = start + visibleIndex
          const selected = index === selectedIndex
          return (
            <Box key={command.name} flexDirection="row" width={paletteWidth}>
              <Box width={nameWidth} flexShrink={0}>
                <Text
                  wrap="truncate-end"
                  {...(selected ? { color: palette.brand, bold: true } : {})}
                >
                  /{command.name}
                </Text>
              </Box>
              <Box width={descriptionWidth} flexShrink={1}>
                <Text dimColor wrap="truncate-end">
                  {command.description}
                </Text>
              </Box>
            </Box>
          )
        })
      )}
    </Box>
  )
}

export function FilePicker({
  entries,
  selectedIndex,
  width,
  screenReader,
}: {
  entries: readonly TuiFileEntry[]
  selectedIndex: number
  width: number
  screenReader: boolean
}) {
  const maxVisible = 12
  const start = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(maxVisible / 2),
      Math.max(0, entries.length - maxVisible),
    ),
  )
  const visible = entries.slice(start, start + maxVisible)
  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      {visible.length === 0 ? (
        <Text dimColor>No matching files.</Text>
      ) : (
        visible.map((entry, visibleIndex) => {
          const index = start + visibleIndex
          return (
            <Text
              key={entry.path}
              inverse={!screenReader && index === selectedIndex}
            >
              {screenReader && index === selectedIndex ? 'Selected: ' : '+ '}
              {entry.path}
            </Text>
          )
        })
      )}
    </Box>
  )
}

export function MentionPicker({
  entries,
  selectedIndex,
  width,
  screenReader,
}: {
  entries: readonly TuiMentionEntry[]
  selectedIndex: number
  width: number
  screenReader: boolean
}) {
  const maxVisible = 12
  const start = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(maxVisible / 2),
      Math.max(0, entries.length - maxVisible),
    ),
  )
  const visible = entries.slice(start, start + maxVisible)
  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      {visible.length === 0 ? (
        <Text dimColor>No matching files or agents.</Text>
      ) : (
        visible.map((entry, visibleIndex) => {
          const index = start + visibleIndex
          const selected = index === selectedIndex
          if (entry.kind === 'agent') {
            return (
              <Text
                key={`agent:${entry.name}`}
                inverse={!screenReader && selected}
                {...(screenReader ? {} : { wrap: 'truncate-end' as const })}
              >
                {screenReader && selected ? 'Selected agent: ' : '* '}
                {entry.name}
                {screenReader ? '' : ' (agent)'}
                {entry.description ? ` – ${entry.description}` : ''}
              </Text>
            )
          }
          return (
            <Text
              key={`file:${entry.path}`}
              inverse={!screenReader && selected}
              {...(screenReader ? {} : { wrap: 'truncate-end' as const })}
            >
              {screenReader && selected ? 'Selected: ' : '+ '}
              {entry.path}
            </Text>
          )
        })
      )}
    </Box>
  )
}

const SHORTCUT_ROWS: readonly (readonly string[])[] = [
  [
    '! for bash mode',
    'double tap esc to clear input',
    'ctrl + shift + _ to undo',
  ],
  ['/ for commands', 'shift + tab to auto-accept edits', 'ctrl + z to suspend'],
  [
    '@ for file paths',
    'ctrl + o for verbose output',
    'ctrl + v to paste images',
  ],
  ['& for background', '', ''],
  [
    '/btw for side question',
    'ctrl + t to toggle tasks',
    'opt + p to switch model',
  ],
  ['', 'backslash (\\) + return (⏎) for newline', 'ctrl + s to stash prompt'],
  ['', '', 'ctrl + g to edit in $EDITOR'],
  ['', '', '/keybindings to customize'],
]

export function ShortcutHelp({ width }: { width: number }) {
  const wide = width >= 78
  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      {SHORTCUT_ROWS.map((row, rowIndex) =>
        wide ? (
          <Box key={rowIndex} flexDirection="row">
            {row.map((cell, cellIndex) => (
              <Box key={cellIndex} width={cellIndex === 2 ? undefined : '33%'}>
                <Text dimColor>{cell}</Text>
              </Box>
            ))}
          </Box>
        ) : (
          row.filter(Boolean).map((cell, cellIndex) => (
            <Text key={`${rowIndex}-${cellIndex}`} dimColor>
              {cell}
            </Text>
          ))
        ),
      )}
    </Box>
  )
}

export function HelpMenu({
  tabIndex,
  selectedIndex,
  builtinCommands,
  customCommands,
  width,
  screenReader,
}: {
  tabIndex: number
  selectedIndex: number
  builtinCommands: readonly TuiSlashCommand[]
  customCommands: readonly TuiSlashCommand[]
  width: number
  screenReader: boolean
}) {
  const palette = useTuiPalette()
  const tabs = ['General', 'Commands', 'Custom commands'] as const
  const commands = tabIndex === 1 ? builtinCommands : customCommands
  const maxVisible = 10
  const start = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(maxVisible / 2),
      Math.max(0, commands.length - maxVisible),
    ),
  )
  const visible = commands.slice(start, start + maxVisible)
  const line = '─'.repeat(Math.max(12, Math.min(100, width)))
  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      {!screenReader ? <Text dimColor>{line}</Text> : null}
      <Box>
        <Text bold> Help </Text>
        {tabs.map((tab, index) => (
          <Text
            key={tab}
            {...(index === tabIndex
              ? { color: palette.brand, bold: true }
              : {})}
          >
            {' '}
            {tab}{' '}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {tabIndex === 0 ? (
          <>
            <Text>
              Praxis understands your codebase, makes edits with your
              permission, and executes commands from your terminal.
            </Text>
            <Text bold>Shortcuts</Text>
            <ShortcutHelp width={width} />
          </>
        ) : (
          <>
            <Text bold>
              {tabIndex === 1
                ? 'Browse default commands'
                : 'Browse shared commands and skills'}
            </Text>
            {visible.length === 0 ? (
              <Text dimColor>No commands found.</Text>
            ) : (
              visible.map((command, visibleIndex) => {
                const index = start + visibleIndex
                return (
                  <Box key={command.name} flexDirection="column">
                    <Text
                      {...(index === selectedIndex
                        ? { color: palette.brand, bold: true }
                        : {})}
                    >
                      {index === selectedIndex ? '↓ ' : '  '}/{command.name}
                    </Text>
                    <Text dimColor> {command.description}</Text>
                  </Box>
                )
              })
            )}
          </>
        )}
      </Box>
      <Text dimColor>←/→ to switch · ↑/↓ to navigate · Esc to cancel</Text>
    </Box>
  )
}

export interface TuiSelectionOption {
  label: string
  description: string
  selected?: boolean
}

export function SelectionMenu({
  title,
  description,
  options,
  selectedIndex,
  footer,
  width,
  screenReader,
}: {
  title: string
  description?: string
  options: readonly TuiSelectionOption[]
  selectedIndex: number
  footer: string
  width: number
  screenReader: boolean
}) {
  const palette = useTuiPalette()
  const maxVisible = 7
  const start = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(maxVisible / 2),
      Math.max(0, options.length - maxVisible),
    ),
  )
  const visible = options.slice(start, start + maxVisible)
  const current = options.find((option) => option.selected)
  const maxLabelWidth = options.reduce(
    (max, option, index) =>
      Math.max(max, `${index + 1}. ${option.label}`.length),
    0,
  )
  return (
    <Box
      borderStyle={screenReader ? undefined : 'round'}
      borderColor={palette.muted}
      flexDirection="column"
      marginTop={1}
      paddingX={screenReader ? 0 : 1}
      width={screenReader ? undefined : Math.min(80, width)}
    >
      <Text bold>{title}</Text>
      {description ? <Text dimColor>{description}</Text> : null}
      {screenReader && current ? <Text>Current: {current.label}</Text> : null}
      {visible.map((option, visibleIndex) => {
        const index = start + visibleIndex
        const selected = index === selectedIndex
        const rowLabel = `${index + 1}. ${option.label}`
        return (
          <Box
            key={`${index}-${option.label}`}
            flexDirection="column"
            marginTop={1}
          >
            <Text
              {...(!screenReader && selected
                ? { color: palette.brand, bold: true }
                : {})}
            >
              {selectionPrefix(selected, screenReader)}
              {rowLabel}
              {!screenReader && option.selected ? ' ✔' : ''}
              {option.description ? (
                <Text dimColor>
                  {' '.repeat(
                    Math.max(
                      2,
                      maxLabelWidth -
                        rowLabel.length -
                        (option.selected && !screenReader ? 2 : 0),
                    ),
                  )}
                  {option.description}
                </Text>
              ) : null}
            </Text>
          </Box>
        )
      })}
      {start > 0 || start + visible.length < options.length ? (
        <Text dimColor>
          {start > 0 ? `↑ ${start} earlier` : ''}
          {start > 0 && start + visible.length < options.length ? ' · ' : ''}
          {start + visible.length < options.length
            ? `↓ ${options.length - start - visible.length} more`
            : ''}
        </Text>
      ) : null}
      <Text dimColor>{footer}</Text>
    </Box>
  )
}

export function ModelMenu({
  options,
  effort,
  selectedIndex,
  width,
  screenReader,
}: {
  options: readonly TuiSelectionOption[]
  effort: string
  selectedIndex: number
  width: number
  screenReader: boolean
}) {
  const palette = useTuiPalette()
  const current = options.find((option) => option.selected)
  const maxLabelWidth = options.reduce(
    (max, option, index) =>
      Math.max(max, `${index + 1}. ${option.label}`.length),
    0,
  )
  return (
    <Box
      borderStyle={screenReader ? undefined : 'round'}
      borderColor={palette.muted}
      flexDirection="column"
      marginTop={1}
      paddingX={screenReader ? 0 : 1}
      width={screenReader ? undefined : Math.min(80, width)}
    >
      <Text bold>Select model</Text>
      <Text dimColor>
        {
          'Switch between models. Your pick applies to this and future Praxis Code sessions. For other model names, specify with --model.'
        }
      </Text>
      {screenReader && current ? <Text>Current: {current.label}</Text> : null}
      {options.map((option, index) => {
        const selected = index === selectedIndex
        const rowLabel = `${index + 1}. ${option.label}`
        return (
          <Box
            key={`${index}-${option.label}`}
            flexDirection="column"
            marginTop={1}
          >
            <Text
              {...(!screenReader && selected
                ? { color: palette.brand, bold: true }
                : {})}
            >
              {selectionPrefix(selected, screenReader)}
              {rowLabel}
              {!screenReader && option.selected ? ' ✔' : ''}
              {option.description ? (
                <Text dimColor>
                  {' '.repeat(
                    Math.max(
                      2,
                      maxLabelWidth -
                        rowLabel.length -
                        (option.selected && !screenReader ? 2 : 0),
                    ),
                  )}
                  {option.description}
                </Text>
              ) : null}
            </Text>
          </Box>
        )
      })}
      <Box marginTop={1}>
        <Text>
          <Text color={palette.accent}>● </Text>
          {effort.charAt(0).toUpperCase() + effort.slice(1)} effort (default)
          <Text dimColor> ←/→ to adjust</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Enter to select · Esc to cancel</Text>
      </Box>
    </Box>
  )
}

function ComposerInput({ input, cursor }: { input: string; cursor: number }) {
  const palette = useTuiPalette()
  const { before, current, after } = composerEditorSegments({
    text: input,
    cursor,
  })
  const cursorText = current === '\n' ? '↵' : (current ?? ' ')
  return (
    <Text>
      {before}
      <Text color={palette.selectionText} backgroundColor={palette.accent}>
        {cursorText}
      </Text>
      {after}
    </Text>
  )
}

export function ExternalEditorWait({
  screenReader,
}: {
  screenReader: boolean
}) {
  if (screenReader)
    return <Text>External editor open. Save and close it to continue.</Text>
  return (
    <Box flexDirection="column">
      <Text dimColor>────────────────────────</Text>
      <Text>Save and close editor to continue...</Text>
      <Text dimColor>────────────────────────</Text>
    </Box>
  )
}

export function Composer({
  input,
  cursor,
  busy,
  clipboardBusy = false,
  status,
  display,
  usage,
  costUsd,
  width,
  screenReader,
  hasThinking = false,
  thinkingExpanded = false,
  shortcutsVisible = false,
  shellMode = false,
  footerMessage,
  reduceMotion = false,
  progressBar = true,
  turnDuration,
  editorMode = 'normal',
  prStatus,
  sessionColor,
  commandArgumentHint,
}: {
  input: string
  cursor?: number
  busy: boolean
  clipboardBusy?: boolean
  status: string
  display: TuiDisplayMetadata
  usage?: ModelUsage
  costUsd?: number
  width: number
  screenReader: boolean
  hasThinking?: boolean
  thinkingExpanded?: boolean
  shortcutsVisible?: boolean
  shellMode?: boolean
  footerMessage?: { text: string; isError: boolean }
  reduceMotion?: boolean
  progressBar?: boolean
  turnDuration?: string
  editorMode?: 'normal' | 'vim'
  prStatus?: string
  sessionColor?: AgentColorName
  commandArgumentHint?: string
}) {
  const palette = useTuiPalette()
  const [spinnerIndex, setSpinnerIndex] = useState(0)
  useEffect(() => {
    if (!busy || screenReader || reduceMotion) return
    const timer = setInterval(
      () => setSpinnerIndex((current) => (current + 1) % SPINNER.length),
      90,
    )
    return () => clearInterval(timer)
  }, [busy, reduceMotion, screenReader])
  if (screenReader)
    return (
      <Text>
        {clipboardBusy
          ? 'Pasting…'
          : busy
            ? `Status: ${status}`
            : shellMode
              ? `Shell command: ${input}`
              : `Prompt: ${input}`}
      </Text>
    )
  const line = '─'.repeat(Math.max(12, Math.min(100, width)))
  const separatorColor =
    sessionColor === undefined ? undefined : palette.sessionColors[sessionColor]
  const footerWidth = Math.min(100, width)
  const footerMode = `⏵⏵ ${permissionLabel(display.permissionMode)}`
  const footerCompactMode = `⏵⏵ ${compactPermissionLabel(display.permissionMode)}`
  const footerLeft = composerFooterLeft(
    footerWidth,
    busy,
    hasThinking,
    thinkingExpanded,
    footerMode,
    footerCompactMode,
  )
  const footerMessageLeft = composerFooterLeft(
    footerWidth,
    busy,
    hasThinking,
    thinkingExpanded,
    footerMode,
    footerCompactMode,
    false,
  )
  return (
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      {usage ? (
        <Text dimColor>
          Context · {usage.inputTokens + usage.outputTokens} tokens
          {display.contextWindowTokens
            ? ` / ${display.contextWindowTokens} (${Math.min(
                100,
                Math.round(
                  ((usage.inputTokens + usage.outputTokens) /
                    display.contextWindowTokens) *
                    100,
                ),
              )}%)`
            : ''}
          {usage.cacheReadInputTokens
            ? ` · ${usage.cacheReadInputTokens} cached`
            : ''}
          {costUsd === undefined ? '' : ` · $${costUsd.toFixed(6)}`}
        </Text>
      ) : null}
      <Text
        {...(separatorColor === undefined
          ? { dimColor: true }
          : { color: separatorColor })}
      >
        {line}
      </Text>
      {clipboardBusy ? (
        <Text>Pasting…</Text>
      ) : busy ? (
        <Text>
          {progressBar ? (
            <Text color={palette.accent}>
              {reduceMotion ? '•' : SPINNER[spinnerIndex]}
            </Text>
          ) : null}{' '}
          {status}… <Text dimColor>· esc to interrupt</Text>
        </Text>
      ) : (
        <Text>
          <Text {...(shellMode ? {} : { color: palette.brand })} bold>
            {shellMode ? '! ' : '❯ '}
          </Text>
          {input ? (
            <Text>
              <ComposerInput
                cursor={cursor ?? Array.from(input).length}
                input={input}
              />
              {commandArgumentHint ? (
                <Text dimColor>
                  {input.endsWith(' ') ? '' : ' '}
                  {commandArgumentHint}
                </Text>
              ) : null}
            </Text>
          ) : (
            <Text dimColor>
              {shellMode
                ? 'Enter a shell command'
                : 'Try "review this project"'}
            </Text>
          )}
        </Text>
      )}
      <Text
        {...(separatorColor === undefined
          ? { dimColor: true }
          : { color: separatorColor })}
      >
        {line}
      </Text>
      {shortcutsVisible ? (
        <ShortcutHelp width={width} />
      ) : (
        <Box width={footerWidth}>
          <Text wrap="truncate">
            {shellMode ? (
              <Text dimColor>! for bash mode</Text>
            ) : footerMessage ? (
              <Text>
                <Text dimColor>{footerMessageLeft} · </Text>
                {footerMessage.isError ? (
                  <Text color={palette.error}>{footerMessage.text}</Text>
                ) : (
                  <Text dimColor>{footerMessage.text}</Text>
                )}
              </Text>
            ) : prStatus ? (
              <Text>
                <Text dimColor>{footerLeft} · </Text>
                <Text dimColor>{prStatus}</Text>
              </Text>
            ) : turnDuration ? (
              <Text>
                <Text dimColor>{footerLeft} · </Text>
                <Text dimColor>Cooked for {turnDuration}</Text>
              </Text>
            ) : display.effort ? (
              <Text>
                <Text dimColor>{footerLeft}</Text>
                <Text dimColor> · </Text>
                <Text color={palette.accent}>● {display.effort}</Text>
                {footerWidth >= 100 ? (
                  <Text dimColor>
                    {' '}
                    · {editorMode === 'vim' ? 'vim' : '/effort'}
                  </Text>
                ) : null}
              </Text>
            ) : (
              <Text dimColor>{footerLeft}</Text>
            )}
          </Text>
        </Box>
      )}
    </Box>
  )
}

export function DialogFrame({
  title,
  children,
  screenReader,
}: {
  title: string
  children: React.ReactNode
  screenReader: boolean
}) {
  const palette = useTuiPalette()
  return (
    <Box
      flexDirection="column"
      borderStyle={screenReader ? undefined : 'round'}
      borderColor={palette.warning}
      paddingX={screenReader ? 0 : 1}
      marginTop={1}
    >
      <Text color={palette.warning} bold>
        {title}
      </Text>
      {children}
    </Box>
  )
}
