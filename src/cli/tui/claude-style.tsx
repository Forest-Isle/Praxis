import { useEffect, useState } from 'react'

import { Box, Text, useStdout } from 'ink'

import type { ModelToolCall, ModelUsage } from '../../core/runtime.js'
import { composerEditorSegments } from './composer-editor.js'
import type { TuiFileEntry, TuiMentionEntry } from './file-picker.js'
import { visiblePatchLines, type TuiDiffSnapshot } from './git-diff.js'
import type { TuiPermissionRule } from './permission-settings.js'
import type { TuiSlashCommand } from './slash-commands.js'

const BRAND = '#D97757'
const ACCENT = '#B8A1FF'
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
  | { kind: 'thinking'; text: string }
  | {
      kind: 'context'
      usedTokens: number
      contextWindowTokens: number
      skills: readonly { name: string; tokens: number }[]
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

export function WelcomePanel({
  display,
  width,
}: {
  display: TuiDisplayMetadata
  width: number
}) {
  const panelWidth = Math.min(100, Math.max(32, width))
  const wide = panelWidth >= 68
  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      flexDirection="column"
      width={panelWidth}
      paddingX={1}
    >
      <Box>
        <Text color={BRAND} bold>
          Praxis
        </Text>
        <Text> Code v{display.version} </Text>
        <Text dimColor>{'─'.repeat(Math.max(1, panelWidth - 24))}</Text>
      </Box>
      <Box flexDirection={wide ? 'row' : 'column'} marginTop={1}>
        <Box
          alignItems={wide ? 'center' : undefined}
          flexDirection="column"
          width={wide ? '50%' : '100%'}
        >
          <Text bold>Welcome back!</Text>
          <Text color={BRAND} bold>
            ▐▛███▜▌
          </Text>
          <Text color={BRAND}>▝▜█████▛▘</Text>
          <Text color={BRAND}> ▘▘ ▝▝</Text>
          <Text>
            {display.model ?? 'provider default'}
            {display.effort ? (
              <Text dimColor> · {display.effort} effort</Text>
            ) : null}
          </Text>
          <Text dimColor>{compactPath(display.cwd)}</Text>
        </Box>
        <Box
          flexDirection="column"
          width={wide ? '50%' : '100%'}
          marginTop={wide ? 0 : 1}
        >
          <Text bold>Tips for getting started</Text>
          <Text>Run /help for commands</Text>
          <Text dimColor>───────────────────────</Text>
          <Text bold>Shared with Claude Code</Text>
          <Text>Sessions, memory, skills</Text>
        </Box>
      </Box>
    </Box>
  )
}

function InlineText({ text }: { text: string }) {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/u)
  return (
    <Text>
      {tokens.map((token, index) => {
        if (token.startsWith('`') && token.endsWith('`'))
          return (
            <Text key={index} color="cyan">
              {token.slice(1, -1)}
            </Text>
          )
        if (token.startsWith('**') && token.endsWith('**'))
          return (
            <Text key={index} bold>
              {token.slice(2, -2)}
            </Text>
          )
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(token)
        if (link)
          return (
            <Text key={index} color="blue" underline>
              {link[1]}
            </Text>
          )
        return token
      })}
    </Text>
  )
}

function MarkdownLine({ line }: { line: string }) {
  if (line.startsWith('### '))
    return (
      <Text bold>
        <InlineText text={line.slice(4)} />
      </Text>
    )
  if (line.startsWith('## '))
    return (
      <Text bold color={ACCENT}>
        <InlineText text={line.slice(3)} />
      </Text>
    )
  if (line.startsWith('# '))
    return (
      <Text bold color={BRAND}>
        <InlineText text={line.slice(2)} />
      </Text>
    )
  if (/^[-*] /u.test(line))
    return (
      <Text>
        {'  • '}
        <InlineText text={line.slice(2)} />
      </Text>
    )
  if (/^\d+\. /u.test(line))
    return (
      <Text>
        {'  '}
        <InlineText text={line} />
      </Text>
    )
  if (line.startsWith('> '))
    return (
      <Text dimColor>
        {'│ '}
        <InlineText text={line.slice(2)} />
      </Text>
    )
  return line ? <InlineText text={line} /> : <Text> </Text>
}

function ToolResultText({ text }: { text: string }) {
  return (
    <Box flexDirection="column">
      {text.split('\n').map((line, index) => (
        <Text
          key={index}
          {...(line.startsWith('+') && !line.startsWith('+++')
            ? { color: 'green' as const }
            : line.startsWith('-') && !line.startsWith('---')
              ? { color: 'red' as const }
              : line.startsWith('@@')
                ? { color: 'cyan' as const }
                : { dimColor: true })}
        >
          {line || ' '}
        </Text>
      ))}
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
  const resultLines = contentLines(result?.text ?? '')
  if (call.name === 'Read' && result && !result.isError && !detailed) {
    return (
      <Text>
        {'  '}Read 1 file <Text dimColor>(ctrl+o to expand)</Text>
      </Text>
    )
  }
  const visible = detailed ? resultLines : resultLines.slice(0, 3)
  const hidden = resultLines.length - visible.length
  const errorText =
    (result?.text.length ?? 0) > 500
      ? `${result?.text.slice(0, 497)}...`
      : result?.text
  const oldLines = contentLines(inputString(call, 'old_string'))
  const newLines = contentLines(inputString(call, 'new_string'))
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={ACCENT}>⏺</Text> <Text bold>{toolHeading(call)}</Text>
      </Text>
      {!['Bash', 'Read', 'Edit'].includes(call.name) && detail ? (
        <Text dimColor> {detail}</Text>
      ) : null}
      {result ? (
        <Box marginLeft={2} flexDirection="column">
          {result.isError ? (
            <Text color="red">⎿ Error: {errorText}</Text>
          ) : call.name === 'Edit' ? (
            <>
              <Text dimColor>
                ⎿ Added {newLines.length} line{newLines.length === 1 ? '' : 's'}
                , removed {oldLines.length} line
                {oldLines.length === 1 ? '' : 's'}
              </Text>
              {oldLines.map((line, index) => (
                <Text key={`old-${index}`} color="red">
                  {'   '}
                  {index + 1} -{line}
                </Text>
              ))}
              {newLines.map((line, index) => (
                <Text key={`new-${index}`} color="green">
                  {'   '}
                  {index + 1} +{line}
                </Text>
              ))}
            </>
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
  const summary = text.replace(/\s+/gu, ' ').trim()
  const showFull = screenReader || active || expanded
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text
        {...(!screenReader ? { color: ACCENT } : {})}
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

function ContextUsageBlock({
  usedTokens,
  contextWindowTokens,
  skills,
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
          {usedTokens.toLocaleString()} of {totalTokens.toLocaleString()} tokens
        </Text>
        <Text>Autocompact buffer: {compactBuffer.toLocaleString()} tokens</Text>
        <Text>
          Skills: {skills.map(({ name }) => name).join(', ') || 'none'}
        </Text>
      </Box>
    )
  }
  const usedCells = Math.min(100, Math.ceil((usedTokens / totalTokens) * 100))
  const bufferCells = Math.min(
    100 - usedCells,
    Math.ceil((compactBuffer / totalTokens) * 100),
  )
  const cells = Array.from({ length: 100 }, (_, index) =>
    index < usedCells ? '⛁' : index >= 100 - bufferCells ? '⛝' : '⛶',
  )
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Text bold>Context Usage</Text>
      <Box>
        <Box flexDirection="column" marginRight={2}>
          {Array.from({ length: 10 }, (_, row) => (
            <Text key={row}>
              {cells.slice(row * 10, row * 10 + 10).join(' ')}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>
            {usedTokens.toLocaleString()}/{totalTokens.toLocaleString()} tokens
          </Text>
          <Text> </Text>
          <Text bold>Estimated usage by category</Text>
          <Text>
            ⛁ Skills:{' '}
            {skills
              .reduce((total, skill) => total + skill.tokens, 0)
              .toLocaleString()}{' '}
            tokens
          </Text>
          <Text>
            ⛶ Free space: {Math.max(0, usable - usedTokens).toLocaleString()}
          </Text>
          <Text>
            ⛝ Autocompact buffer: {compactBuffer.toLocaleString()} tokens
          </Text>
        </Box>
      </Box>
      <Text> </Text>
      <Text>Auto-compact window: {totalTokens.toLocaleString()} tokens</Text>
      <Text> </Text>
      <Text bold>Skills · /skills</Text>
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

export function MarkdownText({ text }: { text: string }) {
  const lines = text.split('\n')
  let code = false
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => {
        if (line.startsWith('```')) {
          code = !code
          return (
            <Text key={index} dimColor>
              {code ? `╭─ ${line.slice(3) || 'code'}` : '╰─'}
            </Text>
          )
        }
        return code ? (
          <Text key={index} color="cyan">
            │ {line}
          </Text>
        ) : (
          <MarkdownLine key={index} line={line} />
        )
      })}
    </Box>
  )
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
  return (
    <Box flexDirection="column">
      {items.map((item, index) => {
        if (item.kind === 'user') {
          return (
            <Box key={index} marginTop={index === 0 ? 0 : 1}>
              <Text color={BRAND} bold>
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
              {!screenReader ? <Text color={ACCENT}>⏺ </Text> : null}
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
              <Text color={item.isError ? 'red' : 'gray'}>
                {item.isError ? '└ Error' : '└ Result'}
              </Text>
              {item.isError ? (
                <Text color="red">{text}</Text>
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
                        {...(result.isError ? { color: 'red' as const } : {})}
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
              {...(item.isError ? { color: 'red' as const } : {})}
            >
              ⎿ {output}
            </Text>
          )
        }
        return (
          <Text
            key={index}
            {...(item.kind === 'warning' ? { color: 'red' as const } : {})}
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
            <Text color={ACCENT}>✳ </Text>
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
            <Text key={item.label} inverse={index === sourceIndex}>
              {' '}
              {item.label}{' '}
            </Text>
          ))}
        </Text>
        <Text> </Text>
        <Text bold> {selected.path}</Text>
        <Text dimColor> {'─'.repeat(Math.max(1, panelWidth - 4))}</Text>
        {lines.map((patchLine, index) => (
          <Text
            key={`${scrollOffset}-${index}`}
            {...(patchLine.startsWith('+')
              ? { color: 'green' as const }
              : patchLine.startsWith('-')
                ? { color: 'red' as const }
                : { dimColor: true })}
          >
            {'  '}
            {patchLine}
          </Text>
        ))}
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
          <Text key={item.label} inverse={index === sourceIndex}>
            {' '}
            {item.label}{' '}
          </Text>
        ))}
      </Text>
      <Text> </Text>
      <Text>
        {'  '}
        {snapshot.files.length} file{snapshot.files.length === 1 ? '' : 's'}{' '}
        changed <Text color="green">+{snapshot.additions}</Text>{' '}
        <Text color="red">-{snapshot.deletions}</Text>
      </Text>
      <Text> </Text>
      {snapshot.files.length === 0 ? (
        <Text dimColor> No uncommitted changes.</Text>
      ) : (
        snapshot.files.map((file, index) => (
          <Text key={file.path} inverse={index === selectedIndex}>
            {index === selectedIndex ? '❯ ' : '  '}
            {file.path} <Text color="green">+{file.additions}</Text>{' '}
            <Text color="red">-{file.deletions}</Text>
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
  workspaceModes,
  width,
  screenReader,
}: {
  tabIndex: number
  selectedIndex: number
  query: string
  rules: readonly TuiPermissionRule[]
  recentDenied: readonly string[]
  workspaceModes: readonly { label: string; selected: boolean }[]
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
  const rows =
    tabIndex === 0
      ? recentDenied
      : tabIndex === 4
        ? workspaceModes.map(
            (mode) => `${mode.selected ? '●' : '○'} ${mode.label}`,
          )
        : [
            ...matchingRules.map((rule) => `${rule.rule}  ${rule.scope}`),
            'Add a new rule…',
          ]
  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      {!screenReader ? (
        <Text dimColor>{'─'.repeat(Math.min(100, width))}</Text>
      ) : null}
      <Text bold> Permissions</Text>
      <Text>
        {'  '}
        {tabs.map((tab, index) => (
          <Text key={tab} inverse={index === tabIndex}>
            {' '}
            {tab}{' '}
          </Text>
        ))}
      </Text>
      {tabIndex >= 1 && tabIndex <= 3 ? (
        <Box
          borderStyle={screenReader ? undefined : 'round'}
          paddingX={1}
          marginY={1}
        >
          <Text {...(query ? {} : { dimColor: true })}>
            ⌕ {query || 'Search rules…'}
          </Text>
        </Box>
      ) : (
        <Text> </Text>
      )}
      {rows.length === 0 ? (
        <Text dimColor>
          {tabIndex === 0 ? '  No recently denied tools.' : '  No entries.'}
        </Text>
      ) : (
        rows.map((row, index) => (
          <Text key={`${index}-${row}`} inverse={index === selectedIndex}>
            {index === selectedIndex ? '❯ ' : '  '}
            {row}
          </Text>
        ))
      )}
      <Text> </Text>
      <Text dimColor>
        ←/→ tabs · ↑/↓ select · type to search · Enter to choose · Esc to close
      </Text>
    </Box>
  )
}

export function StatusDashboard({
  tabIndex,
  version,
  sessionId,
  display,
  usage,
  costUsd,
  turnCount,
  toolCount,
  commandCount,
  detailedTranscript,
  width,
  screenReader,
}: {
  tabIndex: number
  version: string
  sessionId: string | null
  display: TuiDisplayMetadata
  usage?: ModelUsage
  costUsd?: number
  turnCount: number
  toolCount: number
  commandCount: number
  detailedTranscript: boolean
  width: number
  screenReader: boolean
}) {
  const tabs = ['Settings', 'Status', 'Config', 'Usage', 'Stats'] as const
  const rows =
    tabIndex === 0
      ? [
          ['Thinking mode', 'provider controlled'],
          ['Verbose output', detailedTranscript ? 'true' : 'false'],
          ['Default permission mode', permissionLabel(display.permissionMode)],
          ['Context compaction', 'automatic'],
          ['Shared Claude data', 'enabled'],
        ]
      : tabIndex === 1
        ? [
            ['Version', version],
            ['Session ID', sessionId ?? 'new session'],
            ['cwd', display.cwd],
            ['Model', display.model ?? 'provider default'],
            ['Permission mode', permissionLabel(display.permissionMode)],
          ]
        : tabIndex === 2
          ? [
              ['Model', display.model ?? 'provider default'],
              ['Effort', display.effort ?? 'high'],
              [
                'Context window',
                String(display.contextWindowTokens ?? 'provider default'),
              ],
              ['Available commands', String(commandCount)],
            ]
          : tabIndex === 3
            ? [
                ['Input tokens', String(usage?.inputTokens ?? 0)],
                ['Output tokens', String(usage?.outputTokens ?? 0)],
                [
                  'Session cost',
                  costUsd === undefined
                    ? 'unavailable'
                    : `$${costUsd.toFixed(4)}`,
                ],
              ]
            : [
                ['Turns', String(turnCount)],
                ['Tool calls', String(toolCount)],
                [
                  'Context used',
                  String(
                    (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
                  ),
                ],
              ]
  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      {!screenReader ? (
        <Text dimColor>{'─'.repeat(Math.min(100, width))}</Text>
      ) : null}
      <Text>
        {'  '}
        {tabs.map((tab, index) => (
          <Text key={tab} inverse={index === tabIndex}>
            {' '}
            {tab}{' '}
          </Text>
        ))}
      </Text>
      <Text> </Text>
      {rows.map(([label, value]) => (
        <Box key={label}>
          <Box width={28}>
            <Text>{label}:</Text>
          </Box>
          <Text>{value}</Text>
        </Box>
      ))}
      <Text> </Text>
      <Text dimColor>←/→/tab to switch · Esc to close</Text>
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
        borderColor="gray"
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
              {...(index === selectedIndex ? { color: BRAND } : {})}
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
    <Box flexDirection="column" width={Math.min(100, width)}>
      {visible.length === 0 ? (
        <Text dimColor>No matching commands.</Text>
      ) : (
        visible.map((command, visibleIndex) => {
          const index = start + visibleIndex
          const selected = index === selectedIndex
          return (
            <Box key={command.name} flexDirection="row">
              <Box width={30}>
                <Text {...(selected ? { color: BRAND, bold: true } : {})}>
                  /{command.name}
                </Text>
              </Box>
              <Box flexGrow={1}>
                <Text dimColor>{command.description}</Text>
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
    '! for shell mode',
    'double tap esc to clear input',
    'ctrl + shift + _ to undo',
  ],
  ['/ for commands', 'shift + tab to cycle permissions', 'ctrl + z to suspend'],
  [
    '@ for file paths',
    'ctrl + o for verbose output',
    'ctrl + v to paste images',
  ],
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
            {...(index === tabIndex ? { color: BRAND, bold: true } : {})}
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
                        ? { color: BRAND, bold: true }
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
  const maxVisible = 7
  const start = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(maxVisible / 2),
      Math.max(0, options.length - maxVisible),
    ),
  )
  const visible = options.slice(start, start + maxVisible)
  return (
    <Box
      borderStyle={screenReader ? undefined : 'round'}
      borderColor="gray"
      flexDirection="column"
      marginTop={1}
      paddingX={screenReader ? 0 : 1}
      width={screenReader ? undefined : Math.min(80, width)}
    >
      <Text bold>{title}</Text>
      {description ? <Text dimColor>{description}</Text> : null}
      {visible.map((option, visibleIndex) => {
        const index = start + visibleIndex
        const selected = index === selectedIndex
        return (
          <Box
            key={`${index}-${option.label}`}
            flexDirection="column"
            marginTop={1}
          >
            <Text {...(selected ? { color: BRAND, bold: true } : {})}>
              {selected ? '❯ ' : '  '}
              {index + 1}. {option.label}
              {option.selected ? ' ✔' : ''}
            </Text>
            {option.description ? (
              <Text dimColor> {option.description}</Text>
            ) : null}
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

function ComposerInput({ input, cursor }: { input: string; cursor: number }) {
  const { before, current, after } = composerEditorSegments({
    text: input,
    cursor,
  })
  const cursorText = current === '\n' ? '↵' : (current ?? ' ')
  return (
    <Text>
      {before}
      <Text color="black" backgroundColor={ACCENT}>
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
}: {
  input: string
  cursor?: number
  busy: boolean
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
}) {
  const [spinnerIndex, setSpinnerIndex] = useState(0)
  useEffect(() => {
    if (!busy || screenReader) return
    const timer = setInterval(
      () => setSpinnerIndex((current) => (current + 1) % SPINNER.length),
      90,
    )
    return () => clearInterval(timer)
  }, [busy, screenReader])
  if (screenReader)
    return (
      <Text>
        {busy
          ? `Status: ${status}`
          : shellMode
            ? `Shell command: ${input}`
            : `Prompt: ${input}`}
      </Text>
    )
  const line = '─'.repeat(Math.max(12, Math.min(100, width)))
  return (
    <Box flexDirection="column" marginTop={1}>
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
      <Text dimColor>{line}</Text>
      {busy ? (
        <Text>
          <Text color={ACCENT}>{SPINNER[spinnerIndex]}</Text> {status}…{' '}
          <Text dimColor>· esc to interrupt</Text>
        </Text>
      ) : (
        <Text>
          <Text {...(shellMode ? {} : { color: BRAND })} bold>
            {shellMode ? '! ' : '❯ '}
          </Text>
          {input ? (
            <ComposerInput
              cursor={cursor ?? Array.from(input).length}
              input={input}
            />
          ) : (
            <Text dimColor>
              {shellMode
                ? 'Enter a shell command'
                : 'Try "review this project"'}
            </Text>
          )}
        </Text>
      )}
      <Text dimColor>{line}</Text>
      {shortcutsVisible ? (
        <ShortcutHelp width={width} />
      ) : (
        <Box width={Math.min(100, width)}>
          <Text dimColor>
            {shellMode ? (
              '! for shell mode'
            ) : (
              <>
                ⏵⏵ {permissionLabel(display.permissionMode)} ·{' '}
                {busy ? 'esc to interrupt' : '? for shortcuts'} · ← for agents
                {hasThinking
                  ? ` · ctrl+o ${thinkingExpanded ? 'collapse' : 'expand'}`
                  : ''}
              </>
            )}
          </Text>
          <Box flexGrow={1} />
          {footerMessage ? (
            footerMessage.isError ? (
              <Text color="red">{footerMessage.text}</Text>
            ) : (
              <Text dimColor>{footerMessage.text}</Text>
            )
          ) : display.effort ? (
            <Text>
              <Text color={ACCENT}>● {display.effort}</Text>
              <Text dimColor> · /effort</Text>
            </Text>
          ) : null}
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
  return (
    <Box
      flexDirection="column"
      borderStyle={screenReader ? undefined : 'round'}
      borderColor="yellow"
      paddingX={screenReader ? 0 : 1}
      marginTop={1}
    >
      <Text color="yellow" bold>
        {title}
      </Text>
      {children}
    </Box>
  )
}
