import { useEffect, useState } from 'react'

import { Box, Text, useStdout } from 'ink'

import type { ModelToolCall, ModelUsage } from '../../core/runtime.js'

const BRAND = '#D97757'
const ACCENT = '#B8A1FF'
const SPINNER = ['✳', '✢', '✣', '✤', '✥'] as const

export interface TuiDisplayMetadata {
  version: string
  cwd: string
  model?: string
  effort?: string
  permissionMode?: string
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
  const panelWidth = Math.min(80, Math.max(32, width))
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
        <Box flexDirection="column" width={wide ? '62%' : '100%'}>
          <Text bold>Welcome back!</Text>
          <Text color={BRAND} bold>
            {'        ◆'}
          </Text>
          <Text color={BRAND}>{'      ◆ ◆ ◆'}</Text>
          <Text color={BRAND}>{'        ◆'}</Text>
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
          width={wide ? '38%' : '100%'}
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
  screenReader,
}: {
  items: readonly TranscriptItem[]
  activeText: string
  activeThinking?: string
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
            <Box key={index} marginTop={1}>
              <Text color={ACCENT}>✻ </Text>
              <Text dimColor italic>
                Thought for a moment
                {item.text ? ` · ${item.text.slice(0, 160)}` : ''}
              </Text>
            </Box>
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
        <Box marginTop={1}>
          {screenReader ? (
            <Text>Thinking: </Text>
          ) : (
            <Text color={ACCENT}>✻ </Text>
          )}
          <Text dimColor italic>
            Thinking… {activeThinking.slice(-160)}
          </Text>
        </Box>
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
}: {
  sessions: readonly (null | {
    sessionId: string
    name?: string | null
    lastPrompt?: string | null
    status: string
  })[]
  selectedIndex: number
  screenReader: boolean
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
    <Box
      flexDirection="column"
      borderStyle={screenReader ? undefined : 'round'}
      borderColor="gray"
      paddingX={screenReader ? 0 : 1}
    >
      <Text bold>Resume a session</Text>
      {!screenReader ? (
        <Text dimColor>↑/↓ to move · Enter to select · Esc to cancel</Text>
      ) : null}
      {start > 0 ? <Text dimColor> ↑ {start} earlier</Text> : null}
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
    </Box>
  )
}

export function Composer({
  input,
  busy,
  status,
  display,
  usage,
  width,
  screenReader,
}: {
  input: string
  busy: boolean
  status: string
  display: TuiDisplayMetadata
  usage?: ModelUsage
  width: number
  screenReader: boolean
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
  const line = '─'.repeat(Math.max(12, Math.min(80, width)))
  return (
    <Box flexDirection="column" marginTop={1}>
      {display.effort ? (
        <Box justifyContent="flex-end" width={Math.min(80, width)}>
          <Text color={ACCENT}>◉ {display.effort}</Text>
          <Text dimColor> · /effort</Text>
        </Box>
      ) : null}
      {usage ? (
        <Text dimColor>
          Context · {usage.inputTokens + usage.outputTokens} tokens
          {usage.cacheReadInputTokens
            ? ` · ${usage.cacheReadInputTokens} cached`
            : ''}
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
          {input || <Text dimColor>Try "review this project"</Text>}
        </Text>
      )}
      <Text dimColor>{line}</Text>
      <Text dimColor>
        ⏵⏵ {permissionLabel(display.permissionMode)} · /help for shortcuts
      </Text>
      <Text dimColor>/new · /sessions · /workflows · /exit</Text>
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
