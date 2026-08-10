import { useEffect, useState } from 'react'

import { Box, Text, useStdout } from 'ink'

import type { ModelToolCall, ModelUsage } from '../../core/runtime.js'
import { composerEditorSegments } from './composer-editor.js'
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
  | { kind: 'tool'; call: ModelToolCall; detail: string }
  | {
      kind: 'tool-result'
      callId: string
      text: string
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
  screenReader,
}: {
  items: readonly TranscriptItem[]
  activeText: string
  activeThinking?: string
  thinkingExpanded?: boolean
  screenReader: boolean
}) {
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
            <Box key={index} flexDirection="column" marginTop={1}>
              {screenReader ? <Text>Praxis:</Text> : null}
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
              expanded={thinkingExpanded}
              screenReader={screenReader}
            />
          )
        }
        if (item.kind === 'tool') {
          return (
            <Box key={index} flexDirection="column" marginTop={1}>
              <Text>
                <Text color={ACCENT}>●</Text> <Text bold>{item.call.name}</Text>
              </Text>
              <Text dimColor> {item.detail}</Text>
            </Box>
          )
        }
        if (item.kind === 'tool-result') {
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
          expanded={thinkingExpanded}
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
    return <Text>{busy ? `Status: ${status}` : `Prompt: ${input}`}</Text>
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
          <Text color={BRAND} bold>
            ❯{' '}
          </Text>
          {input ? (
            <ComposerInput
              cursor={cursor ?? Array.from(input).length}
              input={input}
            />
          ) : (
            <Text dimColor>Try "review this project"</Text>
          )}
        </Text>
      )}
      <Text dimColor>{line}</Text>
      {shortcutsVisible ? (
        <ShortcutHelp width={width} />
      ) : (
        <Box width={Math.min(100, width)}>
          <Text dimColor>
            ⏵⏵ {permissionLabel(display.permissionMode)} ·{' '}
            {busy ? 'esc to interrupt' : '? for shortcuts'} · ← for agents
            {hasThinking
              ? ` · ctrl+o ${thinkingExpanded ? 'collapse' : 'expand'}`
              : ''}
          </Text>
          <Box flexGrow={1} />
          {display.effort ? (
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
