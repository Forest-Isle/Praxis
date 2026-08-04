import { useEffect, useMemo, useRef, useState } from 'react'

import { Box, Text, render, useApp, useInput } from 'ink'

import type {
  ForkResult,
  SessionRunResult,
  SessionSummary,
} from '../application/session-service.js'
import type {
  ModelToolCall,
  RuntimeEvent,
  RuntimeEventSink,
} from '../core/runtime.js'
import {
  redactSensitiveText,
  sensitiveEnvironmentValues,
} from '../platform/sensitive-data.js'

interface InteractiveSessionCommands {
  run(prompt: string, signal?: AbortSignal): Promise<SessionRunResult>
  resume(
    sessionId: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<SessionRunResult>
  fork(sessionId: string): Promise<ForkResult>
  sessions(): Promise<SessionSummary[]>
}

export interface InteractiveServiceFactory {
  createService(options: {
    eventSink: RuntimeEventSink
    requireProvider: boolean
    approveRecovery?: (call: ModelToolCall) => boolean | Promise<boolean>
    approveTool?: (call: ModelToolCall) => boolean | Promise<boolean>
    agent?: string
    signal?: AbortSignal
  }): Promise<InteractiveSessionCommands>
}

interface InteractiveAppProps {
  factory: InteractiveServiceFactory
  initialSessions: readonly SessionSummary[]
  signal?: AbortSignal
  onCancel?: () => void
  onTurnChange?: (turn: Promise<void> | null) => void
}

type HistoryLine = {
  kind: 'user' | 'assistant' | 'notice' | 'warning'
  text: string
}

type PendingPermission = {
  kind: 'tool' | 'recovery'
  call: ModelToolCall
  resolve: (approved: boolean) => void
}

function describeTool(
  call: ModelToolCall,
  sensitiveValues: readonly string[],
): string {
  const name = redactSensitiveText(call.name, sensitiveValues)
  const detail = redactSensitiveText(
    JSON.stringify(call.input),
    sensitiveValues,
  )
  return `${name} ${detail.length > 160 ? `${detail.slice(0, 157)}...` : detail}`
}

export function InteractiveApp({
  factory,
  initialSessions,
  signal,
  onCancel,
  onTurnChange,
}: InteractiveAppProps) {
  const { exit } = useApp()
  const sensitiveValues = useMemo(
    () => sensitiveEnvironmentValues(process.env),
    [],
  )
  const choices = useMemo(
    () => [null, ...initialSessions] as const,
    [initialSessions],
  )
  const [selectingSession, setSelectingSession] = useState(
    initialSessions.length > 0,
  )
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedIndexRef = useRef(0)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const inputRef = useRef('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('ready')
  const [activeText, setActiveText] = useState('')
  const [history, setHistory] = useState<HistoryLine[]>([])
  const [permission, setPermission] = useState<PendingPermission | null>(null)
  const permissionRef = useRef<PendingPermission | null>(null)

  useEffect(() => {
    if (!signal) return
    const cancel = () => {
      permissionRef.current?.resolve(false)
      exit()
    }
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
    return () => signal.removeEventListener('abort', cancel)
  }, [exit, signal])

  useEffect(() => () => permissionRef.current?.resolve(false), [])

  const append = (line: HistoryLine) =>
    setHistory((current) => [...current, line])

  const handleEvent = (event: RuntimeEvent) => {
    if (event.type === 'text-delta') {
      setActiveText((current) => current + event.delta)
    } else if (event.type === 'state') {
      setStatus(event.state)
    } else if (event.type === 'tool-call') {
      append({
        kind: 'notice',
        text: `Tool: ${describeTool(event.call, sensitiveValues)}`,
      })
    } else if (event.type === 'tool-result' && event.isError) {
      append({
        kind: 'warning',
        text: `Tool failed: ${redactSensitiveText(event.content, sensitiveValues)}`,
      })
    } else if (event.type === 'warning' || event.type === 'failed') {
      append({
        kind: 'warning',
        text: redactSensitiveText(event.message, sensitiveValues),
      })
    }
  }

  const requestApproval = (
    call: ModelToolCall,
    kind: PendingPermission['kind'],
  ) =>
    new Promise<boolean>((resolveApproval) => {
      let settled = false
      const pending: PendingPermission = {
        kind,
        call,
        resolve: (approved) => {
          if (settled) return
          settled = true
          if (permissionRef.current === pending) permissionRef.current = null
          setPermission((current) => (current === pending ? null : current))
          resolveApproval(approved)
        },
      }
      permissionRef.current = pending
      setPermission(pending)
    })
  const approveTool = (call: ModelToolCall) => requestApproval(call, 'tool')
  const approveRecovery = (call: ModelToolCall) =>
    requestApproval(call, 'recovery')

  const submit = async (prompt: string) => {
    setBusy(true)
    setStatus('assembling-context')
    setActiveText('')
    append({ kind: 'user', text: prompt })
    try {
      const service = await factory.createService({
        eventSink: handleEvent,
        requireProvider: true,
        approveRecovery,
        approveTool,
        ...(signal ? { signal } : {}),
      })
      const result = sessionId
        ? await service.resume(sessionId, prompt, signal)
        : await service.run(prompt, signal)
      setSessionId(result.sessionId)
      append({ kind: 'assistant', text: result.text })
      setActiveText('')
      setStatus('ready')
    } catch (error) {
      append({
        kind: 'warning',
        text: redactSensitiveText(
          error instanceof Error ? error.message : String(error),
          sensitiveValues,
        ),
      })
      setStatus('failed')
    } finally {
      setBusy(false)
    }
  }

  useInput((value, key) => {
    if (key.ctrl && value.toLowerCase() === 'c') {
      permissionRef.current?.resolve(false)
      onCancel?.()
      exit()
      return
    }
    if (permission) {
      if (value.toLowerCase() === 'y') {
        permission.resolve(true)
      } else if (value.toLowerCase() === 'n' || key.return || key.escape) {
        permission.resolve(false)
      }
      return
    }

    if (selectingSession) {
      if (key.upArrow) {
        selectedIndexRef.current = Math.max(0, selectedIndexRef.current - 1)
        setSelectedIndex(selectedIndexRef.current)
      } else if (key.downArrow) {
        selectedIndexRef.current = Math.min(
          choices.length - 1,
          selectedIndexRef.current + 1,
        )
        setSelectedIndex(selectedIndexRef.current)
      } else if (key.return) {
        setSessionId(choices[selectedIndexRef.current]?.sessionId ?? null)
        setSelectingSession(false)
      }
      return
    }

    if (busy) return
    if (key.return) {
      const prompt = inputRef.current.trim()
      inputRef.current = ''
      setInput('')
      if (!prompt) return
      if (prompt === '/exit') {
        exit()
      } else if (prompt === '/new') {
        setSessionId(null)
        append({ kind: 'notice', text: 'Started a new session.' })
      } else if (prompt === '/sessions') {
        selectedIndexRef.current = 0
        setSelectedIndex(0)
        setSelectingSession(true)
      } else {
        const turn = submit(prompt)
        onTurnChange?.(turn)
        void turn.then(
          () => onTurnChange?.(null),
          () => onTurnChange?.(null),
        )
      }
    } else if (key.backspace || key.delete) {
      inputRef.current = inputRef.current.slice(0, -1)
      setInput(inputRef.current)
    } else if (!key.ctrl && !key.meta && value) {
      inputRef.current += value
      setInput(inputRef.current)
    }
  })

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Praxis
      </Text>
      {selectingSession ? (
        <Box flexDirection="column">
          <Text dimColor>Select session · ↑/↓ move · Enter confirm</Text>
          {choices.map((session, index) => (
            <Text key={session?.sessionId ?? 'new'}>
              {index === selectedIndex ? '› ' : '  '}
              {session
                ? `${session.lastPrompt ?? 'Untitled'} · ${session.sessionId}`
                : 'New session'}
            </Text>
          ))}
        </Box>
      ) : (
        <>
          {sessionId ? <Text dimColor>Session {sessionId}</Text> : null}
          {history.map((line, index) => (
            <Text
              key={`${index}-${line.kind}`}
              {...(line.kind === 'warning' ? { color: 'red' } : {})}
            >
              {line.kind === 'user'
                ? 'You: '
                : line.kind === 'assistant'
                  ? 'Praxis: '
                  : '· '}
              {line.text}
            </Text>
          ))}
          {activeText ? <Text>Praxis: {activeText}</Text> : null}
          {permission ? (
            <Text color="yellow">
              {permission.kind === 'recovery' ? 'Retry interrupted ' : 'Allow '}
              {describeTool(permission.call, sensitiveValues)}? (y/N)
            </Text>
          ) : busy ? (
            <Text dimColor>{status}…</Text>
          ) : (
            <>
              <Text>› {input}</Text>
              <Text dimColor>/new · /sessions · /exit</Text>
            </>
          )}
        </>
      )}
    </Box>
  )
}

export async function runInteractive(options: {
  factory: InteractiveServiceFactory
  signal?: AbortSignal
}): Promise<number> {
  const controller = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal
  const listing = await options.factory.createService({
    eventSink: () => undefined,
    requireProvider: false,
    signal,
  })
  const initialSessions = await listing.sessions()
  let activeTurn: Promise<void> | null = null
  const instance = render(
    <InteractiveApp
      factory={options.factory}
      initialSessions={initialSessions}
      signal={signal}
      onCancel={() => controller.abort()}
      onTurnChange={(turn) => {
        activeTurn = turn
      }}
    />,
    { exitOnCtrlC: false, incrementalRendering: true },
  )
  await instance.waitUntilExit()
  if (activeTurn) await activeTurn
  return signal.aborted ? 130 : 0
}
