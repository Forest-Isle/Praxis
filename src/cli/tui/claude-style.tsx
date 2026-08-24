import {
  cloneElement,
  useEffect,
  useMemo,
  useState,
  memo,
  type ReactElement,
} from 'react'

import { Box, Text } from 'ink'

import type { ModelToolCall, ModelUsage } from '../../core/runtime.js'
import type { AgentColorName } from '../../compatibility/claude/agent-color.js'
import type { DataPlane } from '../../persistence/data-plane.js'
import { composerEditorSegments } from './composer-editor.js'
import { composerLayoutForWidth } from './composer-layout.js'
import type { TuiFileEntry, TuiMentionEntry } from './file-picker.js'
import type { TuiDiffSurfaceModel } from './diff-surface-model.js'
import { TUI_HOOK_MENU, type TuiHookConfiguration } from './hook-settings.js'
import type { TuiMemoryFileEntry } from './memory-files.js'
import type { CustomThemeToken, TuiCustomTheme } from './custom-themes.js'
import type { TuiCommandPaletteModel } from './command-palette-model.js'
import type { TuiSessionPickerModel } from './session-picker-model.js'
import type {
  TuiHelpShortcut,
  TuiHelpShortcutGroup,
  TuiHelpSurfaceModel,
} from './help-surface-model.js'
import type {
  TranscriptItem,
  TranscriptPresentationEntry,
} from './transcript-presentation.js'
import {
  resolveTuiTheme,
  tuiSyntaxStyle,
  useTuiTheme,
  type TuiSemanticTheme,
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
export type { TranscriptItem } from './transcript-presentation.js'

export interface TuiBtwEntry {
  id: number
  question: string
  answer: string
  status: 'answering' | 'complete' | 'forking' | 'error'
  error?: string
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

function dashboardSelectionPrefix(
  selected: boolean,
  screenReader: boolean,
  noColor: boolean,
): string {
  if (selected) return screenReader || noColor ? 'Selected: ' : '❯ '
  return screenReader || noColor ? '' : '  '
}

export function WelcomePanel({
  display,
  width,
  showTips,
  dataPlane = 'claude',
}: {
  display: TuiDisplayMetadata
  width: number
  showTips: boolean
  dataPlane?: DataPlane
}) {
  const theme = useTuiTheme()
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
      <Text {...theme.text.muted}>
        {'╭───'}
        <Text {...theme.text.productIdentity} bold>
          {brand}
        </Text>
        {` Code v${display.version} `}
        <Text dimColor>{'─'.repeat(fill)}</Text>
        {'╮'}
      </Text>
      <Box
        borderStyle="round"
        {...theme.surface.neutralBorder}
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
          <Text {...theme.text.productIdentity} bold>
            ▐▛███▜▌
          </Text>
          <Text {...theme.text.productIdentity}>▝▜█████▛▘</Text>
          <Text {...theme.text.productIdentity}> ▘▘ ▝▝</Text>
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
          <Text wrap="truncate-end">
            /init to create {dataPlane === 'native' ? 'PRAXIS.md' : 'CLAUDE.md'}
          </Text>
          <Text wrap="truncate-end">/config to open settings</Text>
          <Text dimColor> </Text>
          <Text bold>
            {dataPlane === 'native'
              ? 'Stored by Praxis'
              : 'Shared with Claude Code'}
          </Text>
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
  const theme = useTuiTheme()
  const identityWidth = Math.max(1, Math.floor(width))
  const model = display.model ?? 'provider default'
  const effort = display.effort ? ` · ${display.effort} effort` : ''
  const cwd = compactPath(display.cwd)
  return (
    <Box flexDirection="column" width={identityWidth}>
      <Text wrap="truncate-end">
        <Text {...theme.text.productIdentity} bold>
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

function inlineTextElement(
  text: string,
  theme: TuiSemanticTheme,
): ReactElement {
  return (
    <Text>
      {cachedInlineSegments(text).map((segment, index) => {
        if (segment.kind === 'code')
          return (
            <Text key={index} {...theme.text.info}>
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
            <Text key={index} {...theme.text.link} underline>
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

function markdownLineStyleSignature(theme: TuiSemanticTheme): string {
  return [
    theme.text.focusMarker.color,
    theme.text.productIdentity.color,
    theme.text.info.color,
    theme.text.link.color,
  ].join(ELEMENT_CACHE_KEY_SEPARATOR)
}

const MARKDOWN_LINE_ELEMENT_CACHE_MAX = 4096
const markdownLineElementCache = new Map<string, ReactElement>()

function buildMarkdownLine(
  line: string,
  theme: TuiSemanticTheme,
): ReactElement {
  const shape = cachedMarkdownLineShape(line)
  if (shape.role === 'h3')
    return <Text bold>{inlineTextElement(shape.content, theme)}</Text>
  if (shape.role === 'h2')
    return (
      <Text bold {...theme.text.focusMarker}>
        {inlineTextElement(shape.content, theme)}
      </Text>
    )
  if (shape.role === 'h1')
    return (
      <Text bold {...theme.text.productIdentity}>
        {inlineTextElement(shape.content, theme)}
      </Text>
    )
  if (shape.role === 'bullet')
    return (
      <Text>
        {'  • '}
        {inlineTextElement(shape.content, theme)}
      </Text>
    )
  if (shape.role === 'ordered')
    return (
      <Text>
        {'  '}
        {inlineTextElement(shape.content, theme)}
      </Text>
    )
  if (shape.role === 'quote')
    return (
      <Text dimColor>
        {'│ '}
        {inlineTextElement(shape.content, theme)}
      </Text>
    )
  if (shape.role === 'plain') return inlineTextElement(shape.content, theme)
  return <Text> </Text>
}

function cachedMarkdownLineElement(
  line: string,
  theme: TuiSemanticTheme,
): ReactElement {
  const key = [line, markdownLineStyleSignature(theme)].join(
    ELEMENT_CACHE_KEY_SEPARATOR,
  )
  const cached = markdownLineElementCache.get(key)
  if (cached) return cached
  const element = buildMarkdownLine(line, theme)
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
const syntaxStyleSignatureCache = new WeakMap<TuiSemanticTheme, string>()

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

function syntaxStyleSignature(theme: TuiSemanticTheme): string {
  const cached = syntaxStyleSignatureCache.get(theme)
  if (cached) return cached
  const signature = [
    theme.syntaxHighlightingDisabled ? '1' : '0',
    JSON.stringify(theme.syntax('text')),
    JSON.stringify(theme.syntax('keyword')),
    JSON.stringify(theme.syntax('identifier')),
    JSON.stringify(theme.syntax('string')),
    JSON.stringify(theme.syntax('text', 'removed')),
    JSON.stringify(theme.syntax('text', 'added')),
    JSON.stringify(theme.syntax('addedHighlight')),
  ].join(ELEMENT_CACHE_KEY_SEPARATOR)
  syntaxStyleSignatureCache.set(theme, signature)
  return signature
}

const SYNTAX_LINE_ELEMENT_CACHE_MAX = 4096
const syntaxLineElementCache = new Map<string, ReactElement>()

function buildSyntaxCodeLine(
  text: string,
  prefix: string,
  change: 'added' | 'removed' | undefined,
  theme: TuiSemanticTheme,
): ReactElement {
  if (theme.syntaxHighlightingDisabled) {
    return (
      <Text>
        {prefix}
        {text || ' '}
      </Text>
    )
  }
  const lineStyle = tuiSyntaxStyle(theme, 'text', change)
  return (
    <Text>
      {prefix}
      <Text {...lineStyle}>
        {cachedSyntaxTokens(text).map(({ kind, token }, index) => {
          if (kind === 'text') return token
          return (
            <Text key={index} {...tuiSyntaxStyle(theme, kind)}>
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
  theme: TuiSemanticTheme,
): ReactElement {
  const key = [text, prefix, change ?? '', syntaxStyleSignature(theme)].join(
    ELEMENT_CACHE_KEY_SEPARATOR,
  )
  const cached = syntaxLineElementCache.get(key)
  if (cached) return cached
  const element = buildSyntaxCodeLine(text, prefix, change, theme)
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
  const theme = useTuiTheme()
  return cachedSyntaxCodeLine(text, prefix, change, theme)
}

function ToolResultText({
  text,
  prefix = '',
}: {
  text: string
  prefix?: string
}) {
  const theme = useTuiTheme()
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
            {...(line.startsWith('@@') ? theme.text.info : { dimColor: true })}
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
  const theme = useTuiTheme()
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
  const markerStyle = result
    ? result.isError
      ? theme.text.error
      : theme.text.success
    : theme.text.active
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text {...markerStyle}>⏺</Text>{' '}
        <Text {...theme.text.heading} bold>
          {toolHeading(call)}
        </Text>
      </Text>
      {!['Bash', 'Read', 'Edit'].includes(call.name) && detail ? (
        <Text dimColor> {detail}</Text>
      ) : null}
      {result ? (
        <Box marginLeft={2} flexDirection="column">
          {result.isError ? (
            <Text {...theme.text.error}>⎿ Error: {errorText}</Text>
          ) : call.name === 'Edit' ? (
            <>
              <Text dimColor>
                ⎿ Added {newLines.length} line{newLines.length === 1 ? '' : 's'}
                , removed {oldLines.length} line
                {oldLines.length === 1 ? '' : 's'}
              </Text>
              {detailed &&
                oldLines.map((line, index) => (
                  <SyntaxCodeLine
                    key={`old-${index}`}
                    prefix={`   ${index + 1} -`}
                    text={line}
                    change="removed"
                  />
                ))}
              {detailed &&
                newLines.map((line, index) => (
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
  const theme = useTuiTheme()
  const summary = text.replace(/\s+/gu, ' ').trim()
  const showFull = screenReader || active || expanded
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text
        {...(active
          ? theme.text.active
          : !screenReader
            ? theme.text.focusMarker
            : {})}
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
  const theme = useTuiTheme()
  const totalTokens = Math.max(1, contextWindowTokens)
  const compactBuffer = Math.round(totalTokens * 0.165)
  const usable = Math.max(1, totalTokens - compactBuffer)
  if (screenReader) {
    return (
      <Box flexDirection="column">
        <Text {...theme.text.heading}>Context Usage</Text>
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
      <Text {...theme.text.heading} bold>
        Context Usage
      </Text>
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
      <Text {...theme.text.heading} bold>
        Memory files · /memory
      </Text>
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
      <Text {...theme.text.heading} bold>
        Skills · /skills
      </Text>
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

function markdownTextStyleSignature(theme: TuiSemanticTheme): string {
  return [syntaxStyleSignature(theme), markdownLineStyleSignature(theme)].join(
    ELEMENT_CACHE_KEY_SEPARATOR,
  )
}

const MARKDOWN_TEXT_ELEMENT_CACHE_MAX = 4096
const markdownTextElementCache = new Map<string, ReactElement>()

function buildMarkdownText(
  text: string,
  theme: TuiSemanticTheme,
): ReactElement {
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
            cachedSyntaxCodeLine(line.text, '│ ', undefined, theme),
            { key: index },
          )
        return cloneElement(cachedMarkdownLineElement(line.line, theme), {
          key: index,
        })
      })}
    </Box>
  )
}

function cachedMarkdownTextElement(
  text: string,
  theme: TuiSemanticTheme,
): ReactElement {
  const key = [text, markdownTextStyleSignature(theme)].join(
    ELEMENT_CACHE_KEY_SEPARATOR,
  )
  const cached = markdownTextElementCache.get(key)
  if (cached) return cached
  const element = buildMarkdownText(text, theme)
  markdownTextElementCache.set(key, element)
  if (markdownTextElementCache.size > MARKDOWN_TEXT_ELEMENT_CACHE_MAX) {
    const oldest = markdownTextElementCache.keys().next().value
    if (oldest !== undefined) markdownTextElementCache.delete(oldest)
  }
  return element
}

export function MarkdownText({ text }: { text: string }) {
  const theme = useTuiTheme()
  return cachedMarkdownTextElement(text, theme)
}

// Bounded streaming-text presentation. While a turn is in progress the active
// assistant text grows on every frame; re-parsing the entire Markdown document
// each frame would reflow the whole growing body and could let an unterminated
// fence or heading corrupt the terminal frame. Instead only a bounded window of
// the most recent complete lines is rendered through MarkdownText, and the
// trailing partial line is rendered as plain text so incomplete Markdown stays
// inert. Completed assistant turns still render the full document through the
// regular history Markdown path, so observable final text is unchanged.
export const ACTIVE_STREAM_MAX_LINES = 40

export function activeStreamWindow(text: string): {
  stableText: string
  pendingText: string
  truncated: boolean
} {
  const lastBreak = text.lastIndexOf('\n')
  if (lastBreak === -1) {
    return { stableText: '', pendingText: text, truncated: false }
  }
  const pendingText = text.slice(lastBreak + 1)
  let cursor = lastBreak
  let lines = 0
  // Walk backwards to the newline that starts the bounded window's first line.
  while (lines < ACTIVE_STREAM_MAX_LINES) {
    const previous = cursor > 0 ? text.lastIndexOf('\n', cursor - 1) : -1
    if (previous === -1) {
      cursor = 0
      break
    }
    cursor = previous
    lines += 1
  }
  const windowStart = cursor === 0 ? 0 : cursor + 1
  return {
    stableText: text.slice(windowStart, lastBreak + 1),
    pendingText,
    truncated: windowStart > 0,
  }
}

function ActiveStreamText({ text }: { text: string }) {
  const { stableText, pendingText, truncated } = activeStreamWindow(text)
  return (
    <Box flexDirection="column">
      {truncated ? <Text dimColor>… earlier streaming content …</Text> : null}
      {stableText ? <MarkdownText text={stableText} /> : null}
      {pendingText ? <Text>{pendingText}</Text> : null}
    </Box>
  )
}

const TranscriptEntryRow = memo(
  function TranscriptEntryRow(props: {
    entry: TranscriptPresentationEntry
    first: boolean
    detailed: boolean
    screenReader: boolean
    theme: TuiSemanticTheme
    render: (
      entry: TranscriptPresentationEntry,
      first: boolean,
    ) => ReactElement | null
  }) {
    return props.render(props.entry, props.first)
  },
  (previous, next) =>
    previous.entry === next.entry &&
    previous.first === next.first &&
    previous.detailed === next.detailed &&
    previous.screenReader === next.screenReader &&
    previous.theme === next.theme,
)

function TranscriptViewportSlice({
  entry,
  theme,
}: {
  entry: TranscriptPresentationEntry
  theme: TuiSemanticTheme
}) {
  const slice = entry.viewportSlice
  if (!slice) return null
  const item = entry.kind === 'read-summary' ? undefined : entry.item
  return (
    <Box flexDirection="column">
      {slice.text.split('\n').map((line, index) => {
        if (item?.kind === 'compact')
          return line.includes('Conversation compacted') ? (
            <Text key={index} {...theme.text.focusMarker} italic>
              {line || ' '}
            </Text>
          ) : (
            cloneElement(cachedMarkdownLineElement(line, theme), {
              key: index,
            })
          )
        if (item?.kind === 'thinking')
          return (
            <Text key={index} dimColor italic>
              {line || ' '}
            </Text>
          )
        if (entry.kind === 'tool' && /^\s*\d+\s-[^-]/u.test(line))
          return (
            <SyntaxCodeLine
              key={index}
              prefix=""
              text={line}
              change="removed"
            />
          )
        if (entry.kind === 'tool' && /^\s*\d+\s\+[^+]/u.test(line))
          return (
            <SyntaxCodeLine key={index} prefix="" text={line} change="added" />
          )
        if (
          item?.kind === 'warning' ||
          (entry.kind === 'tool' && entry.result?.isError) ||
          (entry.kind === 'shell' && entry.result?.isError) ||
          (entry.kind === 'orphan-tool-result' && entry.item.isError) ||
          (entry.kind === 'orphan-shell-result' && entry.item.isError)
        )
          return (
            <Text key={index} {...theme.text.error}>
              {line || ' '}
            </Text>
          )
        if (entry.kind === 'tool' && line.startsWith('⏺'))
          return (
            <Text key={index} {...theme.text.heading} bold>
              {line}
            </Text>
          )
        if (
          entry.kind === 'shell' &&
          (line.startsWith('! ') || line.startsWith('Shell command: '))
        )
          return (
            <Text key={index} bold>
              {line}
            </Text>
          )
        return (
          <Text
            key={index}
            bold={item?.kind === 'user'}
            dimColor={
              entry.kind === 'tool' ||
              entry.kind === 'shell' ||
              entry.kind === 'orphan-tool-result' ||
              item?.kind === 'local-result' ||
              item?.kind === 'notice'
            }
          >
            {line || ' '}
          </Text>
        )
      })}
    </Box>
  )
}

export function Transcript({
  entries,
  activeText,
  activeThinking = '',
  activeStreamVisible = true,
  thinkingExpanded = false,
  detailedTranscript = false,
  screenReader,
}: {
  entries: readonly TranscriptPresentationEntry[]
  activeText: string
  activeThinking?: string
  activeStreamVisible?: boolean
  thinkingExpanded?: boolean
  detailedTranscript?: boolean
  screenReader: boolean
}) {
  const theme = useTuiTheme()
  const detailed = thinkingExpanded || detailedTranscript
  const renderEntry = (entry: TranscriptPresentationEntry, first: boolean) => {
    if (
      entry.viewportSlice?.assistantMarkdown &&
      entry.kind === 'item' &&
      entry.item.kind === 'assistant'
    )
      return (
        <Box
          key={entry.key}
          marginTop={entry.viewportSlice.assistantMarkdown.marginTop}
        >
          {screenReader ? <Text {...theme.text.heading}>Praxis:</Text> : null}
          {!screenReader ? <Text {...theme.text.focusMarker}>⏺ </Text> : null}
          <MarkdownText text={entry.item.text} />
        </Box>
      )
    if (
      entry.viewportSlice &&
      !(entry.kind === 'item' && entry.item.kind === 'assistant')
    )
      return (
        <TranscriptViewportSlice key={entry.key} entry={entry} theme={theme} />
      )
    if (entry.kind === 'read-summary') {
      return (
        <Text key={entry.key}>
          {'  '}Read {entry.count} file{entry.count === 1 ? '' : 's'}{' '}
          <Text dimColor>(ctrl+o to expand)</Text>
        </Text>
      )
    }
    const item = entry.item
    if (item.kind === 'user') {
      return (
        <Box key={entry.key} marginTop={first ? 0 : 1}>
          <Text {...theme.text.productIdentity} bold>
            {screenReader ? 'You: ' : '❯ '}
          </Text>
          <Text bold>{item.text}</Text>
        </Box>
      )
    }
    if (item.kind === 'assistant') {
      return (
        <Box key={entry.key} marginTop={1}>
          {screenReader ? <Text {...theme.text.heading}>Praxis:</Text> : null}
          {!screenReader ? <Text {...theme.text.focusMarker}>⏺ </Text> : null}
          <MarkdownText text={item.text} />
        </Box>
      )
    }
    if (item.kind === 'thinking') {
      return (
        <ThinkingBlock
          key={entry.key}
          text={item.text}
          active={false}
          expanded={detailed}
          screenReader={screenReader}
        />
      )
    }
    if (item.kind === 'compact') {
      return (
        <Box key={entry.key} flexDirection="column" marginTop={1}>
          <Text {...theme.text.focusMarker} italic>
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
          key={entry.key}
          {...item}
          screenReader={screenReader}
        />
      )
    }
    if (item.kind === 'tool') {
      return (
        <ToolTranscriptEntry
          key={entry.key}
          call={item.call}
          detail={item.detail}
          {...(entry.kind === 'tool' && entry.result
            ? { result: entry.result }
            : {})}
          detailed={detailed || screenReader}
        />
      )
    }
    if (item.kind === 'tool-result') {
      const text =
        item.text.length > 500 ? `${item.text.slice(0, 497)}...` : item.text
      return (
        <Box key={entry.key} marginLeft={2} flexDirection="column">
          <Text {...(item.isError ? theme.text.error : theme.text.muted)}>
            {item.isError ? '└ Error' : '└ Result'}
          </Text>
          {item.isError ? (
            <Text {...theme.text.error}>{text}</Text>
          ) : (
            <ToolResultText text={text} />
          )}
        </Box>
      )
    }
    if (item.kind === 'shell') {
      const result = entry.kind === 'shell' ? entry.result : undefined
      const output = result
        ? [result.stdout, result.stderr]
            .filter(Boolean)
            .join(
              result.stdout && result.stderr && !result.stdout.endsWith('\n')
                ? '\n'
                : '',
            )
        : ''
      const lines = contentLines(output)
      const visible = detailed || screenReader ? lines : lines.slice(0, 3)
      const hidden = lines.length - visible.length
      return (
        <Box key={entry.key} flexDirection="column" marginTop={1}>
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
                    {...(result.isError ? theme.text.error : {})}
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
      const output = [item.stdout, item.stderr].filter(Boolean).join('\n')
      return (
        <Text key={entry.key} {...(item.isError ? theme.text.error : {})}>
          ⎿ {output}
        </Text>
      )
    }
    if (item.kind === 'local-result') {
      return (
        <Box key={entry.key} marginLeft={2}>
          <Text dimColor>⎿ {item.text}</Text>
        </Box>
      )
    }
    return (
      <Text
        key={entry.key}
        {...(item.kind === 'warning' ? theme.text.error : {})}
        dimColor={item.kind === 'notice'}
      >
        {item.kind === 'warning' ? '⚠ ' : '· '}
        {item.text}
      </Text>
    )
  }
  const historyRows = useMemo(
    () =>
      entries.map((entry, index) => (
        <TranscriptEntryRow
          key={entry.key}
          entry={entry}
          first={index === 0}
          detailed={detailed}
          screenReader={screenReader}
          theme={theme}
          render={renderEntry}
        />
      )),
    [detailed, entries, screenReader, theme],
  )
  return (
    <Box flexDirection="column">
      {historyRows}
      {activeStreamVisible && activeThinking ? (
        <ThinkingBlock
          text={activeThinking}
          active
          expanded={detailed}
          screenReader={screenReader}
        />
      ) : activeStreamVisible && activeText ? (
        <Box marginTop={1}>
          {screenReader ? (
            <Text {...theme.text.active}>Praxis: </Text>
          ) : (
            <Text {...theme.text.active}>✳ </Text>
          )}
          {screenReader ? (
            <MarkdownText text={activeText} />
          ) : (
            <ActiveStreamText text={activeText} />
          )}
        </Box>
      ) : null}
    </Box>
  )
}

export function DiffDashboard({
  model,
  width,
  screenReader,
}: {
  model: TuiDiffSurfaceModel
  width: number
  screenReader: boolean
}) {
  const theme = useTuiTheme()
  const accessibleSelection = screenReader || theme.noColor
  const panelWidth = Number.isFinite(width)
    ? Math.max(1, Math.min(100, Math.trunc(width)))
    : 100
  const line = '─'.repeat(panelWidth)
  const footer = (
    view: Pick<TuiDiffSurfaceModel['view'], 'actions' | 'cancellation'>,
  ) =>
    screenReader
      ? [
          ...view.actions.map((action) => action.screenReaderLabel),
          view.cancellation.screenReaderLabel,
        ].join(' · ')
      : [
          ...view.actions
            .map((action) => action.visualLabel)
            .filter((label): label is string => Boolean(label)),
          view.cancellation.visualLabel,
        ].join(' · ')
  const fileCounts = (file: { additions: number; deletions: number }): string =>
    `${file.additions} ${file.additions === 1 ? 'addition' : 'additions'}; ${file.deletions} ${file.deletions === 1 ? 'deletion' : 'deletions'}`
  const sourceTabs = model.sourceTabs.map((item) => (
    <Text key={item.id} {...(item.selected ? theme.text.selectedTab : {})}>
      {accessibleSelection && item.selected ? 'Current source: ' : ' '}
      {item.label}{' '}
    </Text>
  ))
  if (model.view.kind === 'file-detail') {
    const view = model.view
    return (
      <Box
        flexDirection="column"
        {...(screenReader ? {} : { width: panelWidth })}
      >
        {!screenReader ? <Text dimColor>{line}</Text> : null}
        <Text {...theme.text.heading} bold>
          {model.title}
        </Text>
        <Text>
          {'  '}
          {sourceTabs}
        </Text>
        <Text> </Text>
        <Text {...theme.text.heading} bold>
          {' '}
          {accessibleSelection
            ? `Selected file: ${view.file.path}; ${fileCounts(view.file)}`
            : view.file.path}
        </Text>
        {!screenReader && panelWidth > 4 ? (
          <Text dimColor> {'─'.repeat(Math.max(1, panelWidth - 4))}</Text>
        ) : null}
        {view.patchRows.length === 0 ? (
          <Text dimColor>{view.emptyPatchText}</Text>
        ) : (
          view.patchRows.map((row) =>
            screenReader ? (
              <Text
                key={row.id}
              >{`${row.kind === 'added' ? 'Added' : row.kind === 'removed' ? 'Removed' : 'Context'}: ${row.kind === 'added' || row.kind === 'removed' ? row.text.slice(1) : row.text}`}</Text>
            ) : row.kind === 'added' ? (
              <SyntaxCodeLine
                key={row.id}
                prefix="  "
                text={row.text}
                change="added"
              />
            ) : row.kind === 'removed' ? (
              <SyntaxCodeLine
                key={row.id}
                prefix="  "
                text={row.text}
                change="removed"
              />
            ) : (
              <Text key={row.id} dimColor>
                {'  '}
                {screenReader ? `${row.kind}: ${row.text}` : row.text}
              </Text>
            ),
          )
        )}
        {screenReader ? (
          <>
            <Text>
              Patch lines {view.visibleStart}-{view.visibleEnd} of{' '}
              {view.totalLines}.
            </Text>
            <Text>{footer(view)}</Text>
          </>
        ) : (
          <Text dimColor> {footer(view)}</Text>
        )}
      </Box>
    )
  }
  const view = model.view
  return (
    <Box
      flexDirection="column"
      {...(screenReader ? {} : { width: panelWidth })}
    >
      {!screenReader ? <Text dimColor>{line}</Text> : null}
      <Text {...theme.text.heading} bold>
        {' '}
        {model.title}
      </Text>
      <Text> </Text>
      <Text>
        {'  '}
        {sourceTabs}
      </Text>
      <Text> </Text>
      <Text>
        {'  '}
        {view.files.length} file{view.files.length === 1 ? '' : 's'} changed{' '}
        {screenReader ? (
          `${view.totals.additions} ${view.totals.additions === 1 ? 'addition' : 'additions'} ${view.totals.deletions} ${view.totals.deletions === 1 ? 'deletion' : 'deletions'}`
        ) : (
          <>
            <Text {...theme.text.diffAdded}>+{view.totals.additions}</Text>{' '}
            <Text {...theme.text.diffRemoved}>-{view.totals.deletions}</Text>
          </>
        )}
      </Text>
      <Text> </Text>
      {view.files.length === 0 ? (
        <Text dimColor> {view.emptyText}</Text>
      ) : (
        view.files.map((file, index) => (
          <Text
            key={file.id}
            {...(index === view.selectedIndex ? theme.text.selectedRow : {})}
          >
            {accessibleSelection
              ? index === view.selectedIndex
                ? 'Selected: '
                : ''
              : selectionPrefix(index === view.selectedIndex, screenReader)}
            {screenReader ? (
              `${file.path}; ${fileCounts(file)}`
            ) : (
              <>
                {file.path}{' '}
                <Text {...theme.text.diffAdded}>+{file.additions}</Text>{' '}
                <Text {...theme.text.diffRemoved}>-{file.deletions}</Text>
              </>
            )}
          </Text>
        ))
      )}
      <Text> </Text>
      <Text dimColor>{footer(view)}</Text>
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
  const theme = useTuiTheme()
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
  const preview = resolveTuiTheme(
    {
      theme: previewTheme as TuiTheme,
      syntaxHighlightingDisabled,
      ...(selectedCustomTheme === undefined
        ? {}
        : { customTheme: selectedCustomTheme }),
    },
    { environment: process.env, screenReader },
  )
  const syntaxColor = (token: TuiSyntaxToken, change?: 'added' | 'removed') =>
    preview.syntax(token, change)
  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      {!screenReader ? <Text>{'▔'.repeat(Math.min(100, width))}</Text> : null}
      <Text {...theme.text.heading} bold>
        {' '}
        Theme
      </Text>
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
          <Text
            key={option.theme}
            {...(index === selectedIndex ? theme.text.selectedRow : {})}
          >
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
            <Text {...syntaxColor('keyword')}>function</Text>
            <Text {...syntaxColor('text')}> </Text>
            <Text {...syntaxColor('identifier')}>greet</Text>
            <Text {...syntaxColor('text')}>{'() {'}</Text>
          </Text>
          <Text>
            <Text dimColor> 2 - </Text>
            <Text {...syntaxColor('text', 'removed')}>
              {' console.log("Hello, World!"); '}
            </Text>
          </Text>
          <Text>
            <Text dimColor> 2 + </Text>
            <Text {...syntaxColor('text', 'added')}>
              {' console.'}
              <Text {...syntaxColor('identifier')}>log</Text>
              {'('}
              <Text {...syntaxColor('string')}>&quot;Hello, </Text>
              <Text {...syntaxColor('addedHighlight')}>Claude</Text>
              <Text {...syntaxColor('string')}>!&quot;</Text>
              {'); '}
            </Text>
          </Text>
          <Text>
            <Text dimColor> 3 </Text>
            <Text {...syntaxColor('text')}>{'}'}</Text>
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
  const semanticTheme = useTuiTheme()
  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      <Text {...semanticTheme.text.heading} bold>
        {theme.name}
      </Text>
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
              <Text
                key={entry}
                {...(index === 0 ? semanticTheme.text.selectedRow : {})}
              >
                {dashboardSelectionPrefix(
                  index === 0,
                  screenReader,
                  semanticTheme.noColor,
                )}
                ██ {entry}
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
  const theme = useTuiTheme()
  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      {!screenReader ? (
        <Text dimColor>{'─'.repeat(Math.min(100, width))}</Text>
      ) : null}
      <Text {...theme.text.heading} bold>
        {' '}
        {title}
      </Text>
      <Text> </Text>
      {rows.length === 0 ? (
        <Text dimColor> {emptyText}</Text>
      ) : (
        rows.map((row, index) => (
          <Box key={`${index}-${row.label}`} flexDirection="column">
            <Text {...(index === selectedIndex ? theme.text.selectedRow : {})}>
              {dashboardSelectionPrefix(
                index === selectedIndex,
                screenReader,
                theme.noColor,
              )}
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
  dataPlane = 'claude',
}: {
  autoMemoryEnabled: boolean
  entries: readonly TuiMemoryFileEntry[]
  selectedIndex: number
  openedIndex: number | null
  loading?: boolean
  width: number
  screenReader: boolean
  dataPlane?: DataPlane
}) {
  const theme = useTuiTheme()
  const panelWidth = Math.min(100, width)
  return (
    <Box flexDirection="column" width={panelWidth}>
      {!screenReader ? (
        <Text {...theme.text.focusMarker}>{'─'.repeat(panelWidth)}</Text>
      ) : null}
      <Text {...theme.text.heading} bold>
        {' '}
        Memory
      </Text>
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
                <Text
                  {...(index === selectedIndex ? theme.text.selectedRow : {})}
                >
                  {dashboardSelectionPrefix(
                    index === selectedIndex,
                    screenReader,
                    theme.noColor,
                  )}
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
      {dataPlane === 'claude' ? (
        <Text dimColor>
          {' '}
          Learn more: https://code.claude.com/docs/en/memory
        </Text>
      ) : null}
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
  const theme = useTuiTheme()
  const event = configuration.events[eventIndex]
  const matcher = event?.matchers[matcherIndex]
  const hook = matcher?.hooks[hookIndex]
  if (depth === 'detail') {
    return (
      <Box flexDirection="column" width={Math.min(100, width)}>
        {!screenReader ? (
          <Text dimColor>{'─'.repeat(Math.max(12, Math.min(100, width)))}</Text>
        ) : null}
        <Text {...theme.text.heading} bold>
          {' '}
          Hook details
        </Text>
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
      <Text {...theme.text.heading} bold>
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
                  <Text {...(selected ? theme.text.selectedRow : {})}>
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
                {...(selected ? theme.text.selectedRow : {})}
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
                <Text
                  {...(selected ? theme.text.selectedRow : {})}
                  wrap="truncate-end"
                >
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
  const theme = useTuiTheme()
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
        <Text {...theme.text.error}>
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
  model,
  screenReader,
}: {
  model: TuiSessionPickerModel
  screenReader: boolean
}) {
  const theme = useTuiTheme()
  const visible = model.rows.slice(
    model.visibleRange.start,
    model.visibleRange.end,
  )
  return (
    <Box flexDirection="column">
      {!screenReader ? <Text dimColor>{'─'.repeat(80)}</Text> : null}
      <Text {...theme.text.heading} bold>
        {' '}
        Resume session
      </Text>
      <Box
        borderStyle={screenReader ? undefined : 'round'}
        {...theme.surface.neutralBorder}
        paddingX={screenReader ? 0 : 1}
        marginY={1}
      >
        <Text {...(model.query ? {} : { dimColor: true })}>
          {screenReader ? 'Search: ' : '⌕ '}
          {model.query || 'Search…'}
        </Text>
      </Box>
      {model.visibleRange.start > 0 ? (
        <Text dimColor> ↑ {model.visibleRange.start} earlier</Text>
      ) : null}
      {visible.length === 0 ? <Text dimColor>No sessions found.</Text> : null}
      {visible.map((row) => {
        return (
          <Box key={row.id}>
            <Text
              {...(row.selected ? theme.text.selectedRow : {})}
              bold={row.selected}
            >
              {dashboardSelectionPrefix(
                row.selected,
                screenReader,
                theme.noColor,
              )}
              {row.label}
            </Text>
            {row.detail ? <Text dimColor> · {row.detail}</Text> : null}
          </Box>
        )
      })}
      {model.visibleRange.end < model.rows.length ? (
        <Text dimColor>
          {' '}
          ↓ {model.rows.length - model.visibleRange.end} more
        </Text>
      ) : null}
      {!screenReader ? (
        <Text dimColor>
          {model.actions.navigate} · {model.actions.select} ·{' '}
          {model.actions.search} · {model.actions.cancel}
        </Text>
      ) : (
        <Text>
          Actions: {model.actions.navigate}; {model.actions.select};{' '}
          {model.actions.search}; {model.actions.cancel}
        </Text>
      )}
    </Box>
  )
}

export function CommandPalette({
  model,
  width,
  screenReader,
}: {
  model: TuiCommandPaletteModel
  width: number
  screenReader: boolean
}) {
  const theme = useTuiTheme()
  const paletteWidth = Math.max(1, Math.min(100, width))
  const nameWidth = Math.min(30, paletteWidth)
  const descriptionWidth = Math.max(0, paletteWidth - nameWidth)
  const visible = model.rows.slice(
    model.visibleRange.start,
    model.visibleRange.end,
  )
  if (screenReader) {
    return (
      <Box flexDirection="column">
        <Text>Commands</Text>
        {visible.length === 0 ? (
          <Text>No matching commands.</Text>
        ) : (
          visible.map((row) => (
            <Text key={row.id}>
              {row.selected ? 'Selected: ' : ''}
              {row.invocation}: {row.description}
            </Text>
          ))
        )}
        <Text>
          Actions: {model.actions.navigate}; {model.actions.complete};{' '}
          {model.actions.submit}; {model.actions.cancel}
        </Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" width={paletteWidth}>
      {visible.length === 0 ? (
        <Text dimColor>No matching commands.</Text>
      ) : (
        visible.map((row) => {
          return (
            <Box key={row.id} flexDirection="row" width={paletteWidth}>
              <Box width={nameWidth} flexShrink={0}>
                <Text
                  wrap="truncate-end"
                  {...(row.selected ? theme.text.selectedRow : {})}
                >
                  {row.invocation}
                </Text>
              </Box>
              <Box width={descriptionWidth} flexShrink={1}>
                <Text dimColor wrap="truncate-end">
                  {row.description}
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
  const theme = useTuiTheme()
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
              {...(index === selectedIndex ? theme.text.selectedRow : {})}
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
  const theme = useTuiTheme()
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
                {...(selected ? theme.text.selectedRow : {})}
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
              {...(selected ? theme.text.selectedRow : {})}
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

const SHORTCUT_LAYOUT: readonly (readonly (string | null)[])[] = [
  ['bash-mode', 'clear-input', 'undo'],
  ['commands', 'auto-accept-edits', 'suspend'],
  ['file-paths', 'verbose-output', 'paste-images'],
  ['background', null, null],
  ['side-question', 'toggle-tasks', 'switch-model'],
  [null, 'newline', 'stash-prompt'],
  [null, null, 'external-editor'],
  [null, null, 'customize-keybindings'],
]

function shortcutMap(
  groups: readonly TuiHelpShortcutGroup[],
): ReadonlyMap<string, TuiHelpShortcut> {
  return new Map(
    groups.flatMap((group) =>
      group.shortcuts.map((shortcut) => [shortcut.id, shortcut] as const),
    ),
  )
}

export function ShortcutHelp({
  shortcutGroups,
  width,
  screenReader = false,
}: {
  shortcutGroups: readonly TuiHelpShortcutGroup[]
  width: number
  screenReader?: boolean
}) {
  const shortcuts = shortcutMap(shortcutGroups)
  const wide = width >= 78 && !screenReader
  if (screenReader) {
    return (
      <Box flexDirection="column">
        {shortcutGroups.flatMap((group) =>
          group.shortcuts.map((shortcut) => (
            <Text key={shortcut.id} dimColor>
              {shortcut.key} {shortcut.description}
            </Text>
          )),
        )}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      {SHORTCUT_LAYOUT.map((row) => {
        const rowKey = row.filter((id): id is string => id !== null).join('|')
        const cells = row.map((id) =>
          id === null ? undefined : shortcuts.get(id),
        )
        return wide ? (
          <Box key={rowKey} flexDirection="row">
            {cells.map((shortcut, cellIndex) => (
              <Box
                key={shortcut?.id ?? `${rowKey}:blank:${cellIndex}`}
                width={cellIndex === 2 ? undefined : '33%'}
              >
                <Text dimColor>
                  {shortcut ? `${shortcut.key} ${shortcut.description}` : ''}
                </Text>
              </Box>
            ))}
          </Box>
        ) : (
          cells.flatMap((shortcut) =>
            shortcut ? (
              <Text key={shortcut.id} dimColor>
                {shortcut.key} {shortcut.description}
              </Text>
            ) : (
              []
            ),
          )
        )
      })}
    </Box>
  )
}

export function HelpMenu({
  model,
  width,
  screenReader,
}: {
  model: TuiHelpSurfaceModel
  width: number
  screenReader: boolean
}) {
  const theme = useTuiTheme()
  const content = model.activeContent
  const maxVisible = 10
  const focusedIndex = content.kind === 'general' ? null : content.focusedIndex
  const commands = content.kind === 'general' ? [] : content.commands
  const start =
    focusedIndex === null
      ? 0
      : Math.max(
          0,
          Math.min(
            focusedIndex - Math.floor(maxVisible / 2),
            Math.max(0, commands.length - maxVisible),
          ),
        )
  const visible = commands.slice(start, start + maxVisible)
  const line = '─'.repeat(Math.max(12, Math.min(100, width)))
  if (screenReader) {
    return (
      <Box flexDirection="column">
        <Text>You: {model.invocation}</Text>
        <Text>{model.title}</Text>
        <Text>Current tab: {model.activeTab.label}</Text>
        <Text>
          Tabs:{' '}
          {model.tabs
            .map((tab) => `${tab.current ? '(current) ' : ''}${tab.label}`)
            .join(' · ')}
        </Text>
        {content.kind === 'general' ? (
          <>
            <Text>{content.description}</Text>
            <Text>Shortcuts</Text>
            <ShortcutHelp
              shortcutGroups={content.shortcutGroups}
              width={width}
              screenReader
            />
          </>
        ) : (
          <>
            <Text>{content.heading}</Text>
            {content.commands.length === 0 ? (
              <Text>{content.emptyText}</Text>
            ) : (
              content.commands.map((command) => (
                <Text key={command.id}>
                  {command.ordinal}. {command.invocation} —{' '}
                  {command.description}
                </Text>
              ))
            )}
            {content.focusedIndex === null
              ? null
              : (() => {
                  const focused = content.commands[content.focusedIndex]
                  return focused ? (
                    <Text>
                      Focused: {focused.ordinal}. {focused.invocation}
                    </Text>
                  ) : null
                })()}
          </>
        )}
        <Text>
          Actions: {model.navigation.switchTabs}
          {model.navigation.browseCommands
            ? ` · ${model.navigation.browseCommands}`
            : ''}{' '}
          · {model.navigation.close}
        </Text>
        <Text>
          {model.documentation.label}: {model.documentation.url}
        </Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      <Text dimColor>{line}</Text>
      <Box>
        <Text {...theme.text.navigation} bold>
          {' '}
          {model.title}{' '}
        </Text>
        {model.tabs.map((tab) => (
          <Text key={tab.id} {...(tab.current ? theme.text.selectedTab : {})}>
            {' '}
            {tab.label}{' '}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {content.kind === 'general' ? (
          <>
            <Text>{content.description}</Text>
            <Text {...theme.text.heading} bold>
              Shortcuts
            </Text>
            <ShortcutHelp
              shortcutGroups={content.shortcutGroups}
              width={width}
            />
          </>
        ) : (
          <>
            <Text bold>{content.heading}</Text>
            {visible.length === 0 ? (
              <Text dimColor>{content.emptyText}</Text>
            ) : (
              visible.map((command, visibleIndex) => {
                const index = start + visibleIndex
                return (
                  <Box key={command.id} flexDirection="column">
                    <Text
                      {...(index === focusedIndex
                        ? theme.text.selectedRow
                        : {})}
                    >
                      {index === focusedIndex ? '↓ ' : '  '}
                      {command.invocation}
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
      <Text dimColor>
        {model.documentation.label}: {model.documentation.url}
      </Text>
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
  const theme = useTuiTheme()
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
      {...theme.surface.neutralBorder}
      flexDirection="column"
      marginTop={1}
      paddingX={screenReader ? 0 : 1}
      width={screenReader ? undefined : Math.min(80, width)}
    >
      <Text {...theme.text.heading} bold>
        {title}
      </Text>
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
              {...(!screenReader && selected ? theme.text.selectedRow : {})}
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
  const theme = useTuiTheme()
  const current = options.find((option) => option.selected)
  const maxLabelWidth = options.reduce(
    (max, option, index) =>
      Math.max(max, `${index + 1}. ${option.label}`.length),
    0,
  )
  return (
    <Box
      borderStyle={screenReader ? undefined : 'round'}
      {...theme.surface.neutralBorder}
      flexDirection="column"
      marginTop={1}
      paddingX={screenReader ? 0 : 1}
      width={screenReader ? undefined : Math.min(80, width)}
    >
      <Text {...theme.text.heading} bold>
        Select model
      </Text>
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
              {...(!screenReader && selected ? theme.text.selectedRow : {})}
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
          <Text {...theme.text.focusMarker}>● </Text>
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
  const theme = useTuiTheme()
  const { before, current, after } = composerEditorSegments({
    text: input,
    cursor,
  })
  const cursorText = current === '\n' ? '↵' : (current ?? ' ')
  const noColorCursorText =
    current === undefined ? ` ${'\u0332'}` : `${cursorText}\u0332`
  return (
    <Text>
      {before}
      <Text {...theme.text.inputCursor}>
        {theme.noColor ? noColorCursorText : cursorText}
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
  shortcutHelp,
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
  shortcutHelp?: TuiHelpSurfaceModel
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
  const theme = useTuiTheme()
  const [spinnerIndex, setSpinnerIndex] = useState(0)
  useEffect(() => {
    if (!busy || screenReader || reduceMotion) return
    const timer = setInterval(
      () => setSpinnerIndex((current) => (current + 1) % SPINNER.length),
      90,
    )
    return () => clearInterval(timer)
  }, [busy, reduceMotion, screenReader])
  if (screenReader && shortcutsVisible && shortcutHelp)
    return <HelpMenu model={shortcutHelp} width={width} screenReader />
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
  const { lineWidth, footerWidth, showEditorHint } =
    composerLayoutForWidth(width)
  const line = '─'.repeat(lineWidth)
  const separatorColor =
    sessionColor === undefined ? undefined : theme.session(sessionColor)
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
            <Text {...theme.text.focusMarker}>
              {reduceMotion ? '•' : SPINNER[spinnerIndex]}
            </Text>
          ) : null}{' '}
          <Text {...theme.text.active}>{status}…</Text>{' '}
          <Text dimColor>· esc to interrupt</Text>
        </Text>
      ) : (
        <Text>
          <Text
            {...(shellMode ? theme.text.shellMode : theme.text.inputMarker)}
          >
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
        <ShortcutHelp
          shortcutGroups={
            shortcutHelp?.activeContent.kind === 'general'
              ? shortcutHelp.activeContent.shortcutGroups
              : []
          }
          width={width}
        />
      ) : (
        <Box width={footerWidth}>
          <Text wrap="truncate">
            {shellMode ? (
              <Text dimColor>! for bash mode</Text>
            ) : footerMessage ? (
              <Text>
                <Text dimColor>{footerMessageLeft} · </Text>
                {footerMessage.isError ? (
                  <Text {...theme.text.error}>{footerMessage.text}</Text>
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
                <Text {...theme.text.focusMarker}>● {display.effort}</Text>
                {showEditorHint ? (
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
  const theme = useTuiTheme()
  return (
    <Box
      flexDirection="column"
      borderStyle={screenReader ? undefined : 'round'}
      {...theme.surface.decision}
      paddingX={screenReader ? 0 : 1}
      marginTop={1}
    >
      <Text {...theme.text.heading} {...theme.text.warning} bold>
        {title}
      </Text>
      {children}
    </Box>
  )
}
