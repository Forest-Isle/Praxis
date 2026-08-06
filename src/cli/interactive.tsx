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
  workflows?(): readonly Record<string, unknown>[]
  nextScheduledPrompt?(
    signal?: AbortSignal,
  ): Promise<{ id: string; prompt: string } | null>
  close?(): Promise<void>
}

export interface InteractiveServiceFactory {
  scheduledPrompts?: boolean
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
  const serviceRef = useRef<InteractiveSessionCommands | null>(null)
  const serviceCreationRef = useRef<
    Promise<InteractiveSessionCommands> | undefined
  >(undefined)
  const scheduledWaitRef = useRef<AbortController | null>(null)

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

  useEffect(
    () => () => {
      permissionRef.current?.resolve(false)
      scheduledWaitRef.current?.abort()
      void serviceRef.current?.close?.().catch(() => undefined)
    },
    [],
  )

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

  const service = async () => {
    if (serviceRef.current) return serviceRef.current
    const pending =
      serviceCreationRef.current ??
      factory.createService({
        eventSink: handleEvent,
        requireProvider: true,
        approveRecovery,
        approveTool,
        ...(signal ? { signal } : {}),
      })
    serviceCreationRef.current = pending
    try {
      const created = await pending
      serviceRef.current = created
      return created
    } finally {
      serviceCreationRef.current = undefined
    }
  }

  const submit = async (prompt: string) => {
    scheduledWaitRef.current?.abort()
    setBusy(true)
    setStatus('assembling-context')
    setActiveText('')
    append({ kind: 'user', text: prompt })
    let commands: InteractiveSessionCommands | undefined
    try {
      commands = await service()
      const result = sessionId
        ? await commands.resume(sessionId, prompt, signal)
        : await commands.run(prompt, signal)
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
      if (!factory.scheduledPrompts && commands) {
        try {
          await commands.close?.()
        } catch (error) {
          append({
            kind: 'warning',
            text: redactSensitiveText(
              error instanceof Error ? error.message : String(error),
              sensitiveValues,
            ),
          })
        } finally {
          if (serviceRef.current === commands) serviceRef.current = null
        }
      }
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!factory.scheduledPrompts || selectingSession || busy || permission) {
      return
    }
    const controller = new AbortController()
    scheduledWaitRef.current?.abort()
    scheduledWaitRef.current = controller
    const waitSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal
    void service()
      .then((commands) => commands.nextScheduledPrompt?.(waitSignal) ?? null)
      .then((scheduled) => {
        if (!scheduled || waitSignal.aborted) return
        const turn = submit(scheduled.prompt)
        onTurnChange?.(turn)
        void turn.then(
          () => onTurnChange?.(null),
          () => onTurnChange?.(null),
        )
      })
      .catch((error: unknown) => {
        if (waitSignal.aborted) return
        append({
          kind: 'warning',
          text: redactSensitiveText(
            error instanceof Error ? error.message : String(error),
            sensitiveValues,
          ),
        })
      })
    return () => controller.abort()
  }, [busy, permission, selectingSession, sessionId])

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
      } else if (prompt === '/workflows') {
        const turn = (async () => {
          setBusy(true)
          try {
            const workflows = (await service()).workflows?.() ?? []
            append({
              kind: 'notice',
              text:
                workflows.length === 0
                  ? 'No workflows.'
                  : workflows
                      .map(
                        (workflow) =>
                          `${String(workflow.task_id)} [${String(workflow.status)}] ${String(workflow.summary)}`,
                      )
                      .join('\n'),
            })
          } catch (error) {
            append({
              kind: 'warning',
              text: redactSensitiveText(
                error instanceof Error ? error.message : String(error),
                sensitiveValues,
              ),
            })
          } finally {
            setBusy(false)
          }
        })()
        onTurnChange?.(turn)
        void turn.finally(() => onTurnChange?.(null))
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
                ? `${session.lastPrompt ?? 'Untitled'} · ${session.sessionId}${session.status === 'ready' ? '' : ` · ${session.status}`}`
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
              <Text dimColor>/new · /sessions · /workflows · /exit</Text>
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
  let initialSessions: SessionSummary[]
  try {
    initialSessions = await listing.sessions()
  } catch (error) {
    try {
      await listing.close?.()
    } catch {
      // Preserve the session-listing failure as the primary error.
    }
    throw error
  }
  await listing.close?.()
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
