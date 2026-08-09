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
import type { CliElicitationRequest, CliElicitationResult } from './protocol.js'
import type {
  ClaudeInteractiveToolCallbacks,
  ClaudePlanApprovalRequest,
  ClaudeQuestion,
  ClaudeQuestionResult,
} from '../tools/claude-interactive-tools.js'
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
  fork(sessionId: string, targetSessionId?: string): Promise<ForkResult>
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
    onElicitation?: (
      request: CliElicitationRequest,
    ) => Promise<CliElicitationResult>
    askUser?: ClaudeInteractiveToolCallbacks['askUser']
    approvePlan?: ClaudeInteractiveToolCallbacks['approvePlan']
    agent?: string
    signal?: AbortSignal
  }): Promise<InteractiveSessionCommands>
}

export interface InteractiveResumeOptions {
  sessionId?: string
  sessionSelector?: string
  requireSession?: boolean
  forkSession?: boolean
  forkSessionId?: string
  retryInterruptedTools?: boolean
}

interface InteractiveAppProps {
  factory: InteractiveServiceFactory
  initialSessions: readonly SessionSummary[]
  initialPrompt?: string
  signal?: AbortSignal
  onCancel?: () => void
  onTurnChange?: (turn: Promise<void> | null) => void
  axScreenReader?: boolean
  allowNewSession?: boolean
  resume?: InteractiveResumeOptions
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

type PendingElicitation = {
  request: CliElicitationRequest
  resolve: (result: CliElicitationResult) => void
}

type PendingQuestion = {
  questions: readonly ClaudeQuestion[]
  index: number
  answers: Readonly<Record<string, string>>
  resolve: (result: ClaudeQuestionResult | null) => void
}

type PendingPlanApproval = {
  request: ClaudePlanApprovalRequest
  resolve: (approved: boolean) => void
}

function questionAnswer(question: ClaudeQuestion, input: string): string {
  const answer = input.trim()
  if (!answer) throw new Error('Enter an option number or text.')
  if (!question.multiSelect) {
    if (!/^\d+$/u.test(answer)) return answer
    const option = question.options[Number(answer) - 1]
    if (!option) throw new Error(`Unknown option ${answer}.`)
    return option.label
  }
  const values = input
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  return values
    .map((value) => {
      if (!/^\d+$/u.test(value)) return value
      const option = question.options[Number(value) - 1]
      if (!option) throw new Error(`Unknown option ${value}.`)
      return option.label
    })
    .join(', ')
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
  initialPrompt,
  signal,
  onCancel,
  onTurnChange,
  axScreenReader = false,
  allowNewSession = true,
  resume,
}: InteractiveAppProps) {
  const { exit } = useApp()
  const sensitiveValues = useMemo(
    () => sensitiveEnvironmentValues(process.env),
    [],
  )
  const choices = useMemo(
    () =>
      allowNewSession ? ([null, ...initialSessions] as const) : initialSessions,
    [allowNewSession, initialSessions],
  )
  const [selectingSession, setSelectingSession] = useState(
    initialSessions.length > 0 && resume?.sessionId === undefined,
  )
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedIndexRef = useRef(0)
  const [sessionId, setSessionId] = useState<string | null>(
    resume?.sessionId ?? null,
  )
  const [pendingFork, setPendingFork] = useState(resume?.forkSession === true)
  const [input, setInput] = useState('')
  const inputRef = useRef('')
  const [busy, setBusy] = useState(false)
  const initialPromptRef = useRef(initialPrompt?.trim() ?? '')
  const [initialPromptPending, setInitialPromptPending] = useState(
    initialPromptRef.current.length > 0,
  )
  const [status, setStatus] = useState('ready')
  const [activeText, setActiveText] = useState('')
  const [history, setHistory] = useState<HistoryLine[]>([])
  const [permission, setPermission] = useState<PendingPermission | null>(null)
  const permissionRef = useRef<PendingPermission | null>(null)
  const [elicitation, setElicitation] = useState<PendingElicitation | null>(
    null,
  )
  const elicitationRef = useRef<PendingElicitation | null>(null)
  const [question, setQuestion] = useState<PendingQuestion | null>(null)
  const questionRef = useRef<PendingQuestion | null>(null)
  const [planApproval, setPlanApproval] = useState<PendingPlanApproval | null>(
    null,
  )
  const planApprovalRef = useRef<PendingPlanApproval | null>(null)
  const serviceRef = useRef<InteractiveSessionCommands | null>(null)
  const serviceCreationRef = useRef<
    Promise<InteractiveSessionCommands> | undefined
  >(undefined)
  const scheduledWaitRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!signal) return
    const cancel = () => {
      permissionRef.current?.resolve(false)
      elicitationRef.current?.resolve({ action: 'cancel' })
      questionRef.current?.resolve(null)
      planApprovalRef.current?.resolve(false)
      exit()
    }
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
    return () => signal.removeEventListener('abort', cancel)
  }, [exit, signal])

  useEffect(
    () => () => {
      permissionRef.current?.resolve(false)
      elicitationRef.current?.resolve({ action: 'cancel' })
      questionRef.current?.resolve(null)
      planApprovalRef.current?.resolve(false)
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
    } else if (event.type === 'user-message') {
      append({ kind: 'assistant', text: event.message })
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

  const requestElicitation = (request: CliElicitationRequest) =>
    new Promise<CliElicitationResult>((resolveResult) => {
      let settled = false
      const pending: PendingElicitation = {
        request,
        resolve: (result) => {
          if (settled) return
          settled = true
          if (elicitationRef.current === pending) elicitationRef.current = null
          setElicitation((current) => (current === pending ? null : current))
          resolveResult(result)
        },
      }
      elicitationRef.current = pending
      setElicitation(pending)
    })
  const approveRecovery = (call: ModelToolCall) =>
    resume?.retryInterruptedTools ? true : requestApproval(call, 'recovery')

  const askUser: ClaudeInteractiveToolCallbacks['askUser'] = (
    questions,
    signal,
  ) =>
    new Promise<ClaudeQuestionResult | null>((resolveResult) => {
      let settled = false
      const abort = () => pending.resolve(null)
      const pending: PendingQuestion = {
        questions,
        index: 0,
        answers: {},
        resolve: (result) => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', abort)
          if (questionRef.current === pending) questionRef.current = null
          setQuestion((current) => (current === pending ? null : current))
          resolveResult(result)
        },
      }
      if (signal?.aborted) {
        pending.resolve(null)
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      inputRef.current = ''
      setInput('')
      questionRef.current = pending
      setQuestion(pending)
    })

  const approvePlan: ClaudeInteractiveToolCallbacks['approvePlan'] = (
    request,
    signal,
  ) =>
    new Promise<boolean>((resolveApproval) => {
      let settled = false
      const abort = () => pending.resolve(false)
      const pending: PendingPlanApproval = {
        request,
        resolve: (approved) => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', abort)
          if (planApprovalRef.current === pending)
            planApprovalRef.current = null
          setPlanApproval((current) => (current === pending ? null : current))
          resolveApproval(approved)
        },
      }
      if (signal?.aborted) {
        pending.resolve(false)
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      planApprovalRef.current = pending
      setPlanApproval(pending)
    })

  const service = async () => {
    if (serviceRef.current) return serviceRef.current
    const pending =
      serviceCreationRef.current ??
      factory.createService({
        eventSink: handleEvent,
        requireProvider: true,
        approveRecovery,
        approveTool,
        onElicitation: requestElicitation,
        askUser,
        approvePlan,
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
      let activeSessionId = sessionId
      if (activeSessionId && pendingFork) {
        const fork = await commands.fork(activeSessionId, resume?.forkSessionId)
        activeSessionId = fork.sessionId
        setSessionId(activeSessionId)
        setPendingFork(false)
      }
      const result = activeSessionId
        ? await commands.resume(activeSessionId, prompt, signal)
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
    if (!initialPromptPending || selectingSession || busy) return
    const prompt = initialPromptRef.current
    if (!prompt) {
      setInitialPromptPending(false)
      return
    }
    initialPromptRef.current = ''
    const turn = submit(prompt)
    onTurnChange?.(turn)
    void turn.then(
      () => {
        setInitialPromptPending(false)
        onTurnChange?.(null)
      },
      () => {
        setInitialPromptPending(false)
        onTurnChange?.(null)
      },
    )
  }, [busy, initialPromptPending, selectingSession])

  useEffect(() => {
    if (
      !factory.scheduledPrompts ||
      initialPromptPending ||
      selectingSession ||
      busy ||
      permission
    ) {
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
  }, [busy, initialPromptPending, permission, selectingSession, sessionId])

  useInput((value, key) => {
    if (key.ctrl && value.toLowerCase() === 'c') {
      permissionRef.current?.resolve(false)
      elicitationRef.current?.resolve({ action: 'cancel' })
      questionRef.current?.resolve(null)
      planApprovalRef.current?.resolve(false)
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

    if (planApproval) {
      if (value.toLowerCase() === 'y') {
        planApproval.resolve(true)
      } else if (value.toLowerCase() === 'n' || key.return || key.escape) {
        planApproval.resolve(false)
      }
      return
    }

    if (question) {
      if (key.escape) {
        question.resolve(null)
      } else if (key.return) {
        try {
          const current = question.questions[question.index]
          if (!current) throw new Error('Question state is invalid.')
          const answer = questionAnswer(current, inputRef.current.trim())
          const answers = { ...question.answers, [current.question]: answer }
          inputRef.current = ''
          setInput('')
          if (question.index === question.questions.length - 1) {
            question.resolve({ answers })
          } else {
            const next = { ...question, index: question.index + 1, answers }
            questionRef.current = next
            setQuestion(next)
          }
        } catch (error) {
          append({
            kind: 'warning',
            text: error instanceof Error ? error.message : String(error),
          })
        }
      } else if (key.backspace || key.delete) {
        inputRef.current = inputRef.current.slice(0, -1)
        setInput(inputRef.current)
      } else if (!key.ctrl && !key.meta && value) {
        inputRef.current += value
        setInput(inputRef.current)
      }
      return
    }

    if (elicitation) {
      if (key.escape) {
        elicitation.resolve({ action: 'cancel' })
      } else if (key.return) {
        const answer = inputRef.current.trim()
        inputRef.current = ''
        setInput('')
        if (!answer || answer.toLowerCase() === 'decline') {
          elicitation.resolve({ action: 'decline' })
        } else if (answer.toLowerCase() === 'cancel') {
          elicitation.resolve({ action: 'cancel' })
        } else if (answer.toLowerCase() === 'accept') {
          elicitation.resolve({ action: 'accept' })
        } else {
          try {
            const content: unknown = JSON.parse(answer)
            if (
              !content ||
              typeof content !== 'object' ||
              Array.isArray(content)
            )
              throw new Error('elicitation content must be a JSON object')
            const elicitationContent = content as Record<
              string,
              string | number | boolean | string[]
            >
            elicitation.resolve({
              action: 'accept',
              content: elicitationContent,
            })
          } catch {
            append({
              kind: 'warning',
              text: 'Elicitation response must be accept, decline, cancel, or a JSON object.',
            })
          }
        }
      } else if (key.backspace || key.delete) {
        inputRef.current = inputRef.current.slice(0, -1)
        setInput(inputRef.current)
      } else if (!key.ctrl && !key.meta && value) {
        inputRef.current += value
        setInput(inputRef.current)
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
        const selected = choices[selectedIndexRef.current]
        setSessionId(selected?.sessionId ?? null)
        if (!selected) setPendingFork(false)
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
        setPendingFork(false)
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
      {axScreenReader ? null : (
        <Text bold color="cyan">
          Praxis
        </Text>
      )}
      {selectingSession ? (
        <Box flexDirection="column">
          {axScreenReader ? null : (
            <Text dimColor>Select session · ↑/↓ move · Enter confirm</Text>
          )}
          {choices.map((session, index) => (
            <Text key={session?.sessionId ?? 'new'}>
              {index === selectedIndex ? '› ' : '  '}
              {session
                ? `${session.name ?? session.lastPrompt ?? 'Untitled'} · ${session.sessionId}${session.status === 'ready' ? '' : ` · ${session.status}`}`
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
          ) : planApproval ? (
            <Box flexDirection="column">
              <Text color="yellow">
                Approve this plan and begin implementation? (y/N)
              </Text>
              <Text dimColor>{planApproval.request.planPath}</Text>
              {planApproval.request.plan ? (
                <Text>{planApproval.request.plan}</Text>
              ) : null}
            </Box>
          ) : question ? (
            <Box flexDirection="column">
              <Text color="yellow">
                {question.questions[question.index]?.header}:{' '}
                {question.questions[question.index]?.question}
              </Text>
              {question.questions[question.index]?.options.map(
                (option, index) => (
                  <Box key={`${index}-${option.label}`} flexDirection="column">
                    <Text>
                      {index + 1}. {option.label} — {option.description}
                    </Text>
                    {option.preview ? (
                      <Text dimColor>{option.preview}</Text>
                    ) : null}
                  </Box>
                ),
              )}
              <Text>› {input}</Text>
              <Text dimColor>
                {question.questions[question.index]?.multiSelect
                  ? 'Enter comma-separated option numbers or custom text · Esc cancels'
                  : 'Enter one option number or custom text · Esc cancels'}
              </Text>
            </Box>
          ) : elicitation ? (
            <Box flexDirection="column">
              <Text color="yellow">
                MCP elicitation ({elicitation.request.serverName}):{' '}
                {elicitation.request.message}
              </Text>
              {elicitation.request.url ? (
                <Text>{elicitation.request.url}</Text>
              ) : null}
              {elicitation.request.requestedSchema ? (
                <Text dimColor>
                  {JSON.stringify(elicitation.request.requestedSchema)}
                </Text>
              ) : null}
              <Text>› {input}</Text>
              <Text dimColor>Enter JSON object to accept · Esc to cancel</Text>
            </Box>
          ) : busy ? (
            <Text dimColor>{status}…</Text>
          ) : (
            <>
              <Text>› {input}</Text>
              {axScreenReader ? null : (
                <Text dimColor>/new · /sessions · /workflows · /exit</Text>
              )}
            </>
          )}
        </>
      )}
    </Box>
  )
}

export async function runInteractive(options: {
  factory: InteractiveServiceFactory
  initialPrompt?: string
  signal?: AbortSignal
  axScreenReader?: boolean
  sessionFilter?: (session: SessionSummary) => boolean
  requireSession?: boolean
  missingSessionMessage?: string
  resume?: InteractiveResumeOptions
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
    const sessions = await listing.sessions()
    initialSessions = options.sessionFilter
      ? sessions.filter(options.sessionFilter)
      : sessions
    if (options.requireSession && initialSessions.length === 0) {
      throw new Error(
        options.missingSessionMessage ??
          'No conversation linked to a pull request in this project',
      )
    }
  } catch (error) {
    try {
      await listing.close?.()
    } catch {
      // Preserve the session-listing failure as the primary error.
    }
    throw error
  }
  await listing.close?.()
  const canonicalResumeSession =
    options.resume?.sessionId === undefined
      ? undefined
      : initialSessions.find(
          (session) =>
            session.sessionId.toLowerCase() ===
            options.resume?.sessionId?.toLowerCase(),
        )
  const resume = canonicalResumeSession
    ? { ...options.resume, sessionId: canonicalResumeSession.sessionId }
    : options.resume
  let activeTurn: Promise<void> | null = null
  const instance = render(
    <InteractiveApp
      factory={options.factory}
      initialSessions={initialSessions}
      {...(options.initialPrompt === undefined
        ? {}
        : { initialPrompt: options.initialPrompt })}
      signal={signal}
      onCancel={() => controller.abort()}
      onTurnChange={(turn) => {
        activeTurn = turn
      }}
      allowNewSession={!options.requireSession}
      {...(resume === undefined ? {} : { resume })}
      {...(options.axScreenReader ? { axScreenReader: true } : {})}
    />,
    { exitOnCtrlC: false, incrementalRendering: !options.axScreenReader },
  )
  await instance.waitUntilExit()
  if (activeTurn) await activeTurn
  return signal.aborted ? 130 : 0
}
