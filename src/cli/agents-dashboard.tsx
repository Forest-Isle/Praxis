import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

import { Box, Text, render, useApp, useInput } from 'ink'

import type { TopLevelAgentSummary } from '../application/top-level-agent-manager.js'
import { loadTuiThemeSettings } from './tui/theme-settings.js'
import {
  DEFAULT_TUI_THEME_SETTINGS,
  TuiThemeProvider,
  type TuiThemeSettings,
  useTuiPalette,
} from './tui/theme.js'

export interface AgentsDashboardManager {
  launch(options: {
    prompt: string
    argv: string[]
    resumeSessionId?: string
    cwd?: string
  }): Promise<{ id: string; sessionId: string }>
  list(options: { cwd?: string; all: boolean }): Promise<TopLevelAgentSummary[]>
  review?(
    agent: Pick<TopLevelAgentSummary, 'id' | 'cwd' | 'sessionId'>,
  ): Promise<string>
  stop(id: string): Promise<void>
  attach(
    id: string,
    input: AsyncIterable<string | Uint8Array>,
    output: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<void>
}

export interface AgentsDashboardDefaults {
  argv: readonly string[]
  cwd?: string
}

export interface AgentsDashboardAppProps {
  manager: AgentsDashboardManager
  defaults: AgentsDashboardDefaults
  signal?: AbortSignal
  refreshIntervalMs?: number
  onCancel?: () => void
}

type DashboardMode = 'list' | 'attach' | 'review'

const DASHBOARD_SECTIONS = [
  'Ready for review',
  'Needs input',
  'Working',
  'Completed',
] as const

interface PromptQueue {
  input: AsyncIterable<string>
  push(value: string): void
  close(): void
}

interface AttachedAgent {
  id: string
  queue: PromptQueue
  controller: AbortController
}

function createPromptQueue(): PromptQueue {
  const values: string[] = []
  let closed = false
  let wake: (() => void) | undefined
  return {
    input: {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        while (!closed) {
          const value = values.shift()
          if (value !== undefined) {
            yield value
            continue
          }
          await new Promise<void>((resolveWait) => {
            wake = resolveWait
          })
        }
      },
    },
    push(value) {
      if (closed) return
      values.push(value)
      wake?.()
      wake = undefined
    },
    close() {
      if (closed) return
      closed = true
      wake?.()
      wake = undefined
    },
  }
}

function isActive(agent: TopLevelAgentSummary): boolean {
  return agent.status !== undefined || agent.state === 'working'
}

function isAttachable(
  agent: TopLevelAgentSummary,
): agent is TopLevelAgentSummary & { id: string } {
  return agent.id !== undefined && agent.state === 'working'
}

function agentStatus(agent: TopLevelAgentSummary): string {
  return agent.tempo ?? agent.status ?? agent.state ?? 'unknown'
}

function trimOutput(output: string): string {
  const limit = 16_000
  return output.length <= limit ? output : `…${output.slice(-limit)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function agentKey(agent: TopLevelAgentSummary): string {
  return agent.id ?? agent.sessionId
}

function sectionFor(
  agent: TopLevelAgentSummary,
): 'Ready for review' | 'Needs input' | 'Working' | 'Completed' {
  if (!isActive(agent)) return 'Completed'
  if (agent.tempo === 'blocked' || agent.needs !== undefined)
    return 'Needs input'
  return agent.status === 'idle' ? 'Ready for review' : 'Working'
}

function groupAgents(
  agents: readonly TopLevelAgentSummary[],
): TopLevelAgentSummary[] {
  return DASHBOARD_SECTIONS.flatMap((section) =>
    agents.filter((agent) => sectionFor(agent) === section),
  )
}

function AgentSection({
  title,
  agents,
  selected,
}: {
  title: string
  agents: TopLevelAgentSummary[]
  selected?: TopLevelAgentSummary
}) {
  const palette = useTuiPalette()
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>
        {title} ({agents.length})
      </Text>
      {agents.length === 0 ? (
        <Text dimColor> None</Text>
      ) : (
        agents.map((agent) => (
          <Text
            key={agentKey(agent)}
            {...(agent === selected ? { color: palette.accent } : {})}
          >
            {agent === selected ? '› ' : '  '}
            {agent.name} · {agentStatus(agent)} · {agentKey(agent)}
          </Text>
        ))
      )}
    </Box>
  )
}

export function AgentsDashboardApp({
  manager,
  defaults,
  signal,
  refreshIntervalMs = 1_000,
  onCancel,
}: AgentsDashboardAppProps) {
  const { exit } = useApp()
  const palette = useTuiPalette()
  const [agents, setAgents] = useState<TopLevelAgentSummary[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedIndexRef = useRef(0)
  const selectedKeyRef = useRef<string | undefined>(undefined)
  const [mode, setMode] = useState<DashboardMode>('list')
  const [attachedId, setAttachedId] = useState<string>()
  const [input, setInput] = useState('')
  const inputRef = useRef('')
  const [attachedOutput, setAttachedOutput] = useState('')
  const [reviewAgent, setReviewAgent] = useState<TopLevelAgentSummary>()
  const [notice, setNotice] = useState('Loading agents…')
  const [busy, setBusy] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const attachedRef = useRef<AttachedAgent | undefined>(undefined)

  const refresh = useCallback(async () => {
    try {
      const next = groupAgents(
        await manager.list({
          all: true,
          ...(defaults.cwd === undefined ? {} : { cwd: defaults.cwd }),
        }),
      )
      setAgents(next)
      const selectedKey = selectedKeyRef.current
      const matchingIndex =
        selectedKey === undefined
          ? -1
          : next.findIndex((agent) => agentKey(agent) === selectedKey)
      const selected =
        matchingIndex >= 0
          ? matchingIndex
          : Math.min(selectedIndexRef.current, Math.max(0, next.length - 1))
      selectedIndexRef.current = selected
      selectedKeyRef.current = next[selected]
        ? agentKey(next[selected])
        : undefined
      setSelectedIndex(selected)
      setNotice((current) => (current === 'Loading agents…' ? '' : current))
    } catch (error) {
      setNotice(`Could not refresh agents: ${errorMessage(error)}`)
    }
  }, [defaults.cwd, manager])

  const leaveAttached = useCallback(() => {
    const attached = attachedRef.current
    if (!attached) return
    attachedRef.current = undefined
    attached.queue.close()
    attached.controller.abort()
    setMode('list')
    setAttachedId(undefined)
    setAttachedOutput('')
    setNotice(`Detached from ${attached.id}`)
  }, [])

  const leaveReview = useCallback(() => {
    setMode('list')
    setReviewAgent(undefined)
    setAttachedOutput('')
  }, [])

  useEffect(() => {
    void refresh()
    const interval = setInterval(() => void refresh(), refreshIntervalMs)
    return () => clearInterval(interval)
  }, [refresh, refreshIntervalMs])

  useEffect(() => {
    if (!signal) return
    const cancel = () => {
      leaveAttached()
      exit()
    }
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
    return () => signal.removeEventListener('abort', cancel)
  }, [exit, leaveAttached, signal])

  useEffect(
    () => () => {
      const attached = attachedRef.current
      attached?.queue.close()
      attached?.controller.abort()
    },
    [],
  )

  const launch = useCallback(async () => {
    const prompt = inputRef.current.trim()
    if (!prompt || busy) return
    setBusy(true)
    setNotice('Starting background agent…')
    try {
      const launched = await manager.launch({
        prompt,
        argv: [...defaults.argv, '--', prompt],
        ...(defaults.cwd === undefined ? {} : { cwd: defaults.cwd }),
      })
      inputRef.current = ''
      setInput('')
      setNotice(`Backgrounded ${launched.id}`)
      await refresh()
    } catch (error) {
      setNotice(`Could not start agent: ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }, [busy, defaults, manager, refresh])

  const stopSelected = useCallback(async () => {
    const selected = agents[selectedIndexRef.current]
    if (!selected) {
      setNotice('No agent selected')
      return
    }
    if (!isAttachable(selected)) {
      setNotice(`${agentKey(selected)} cannot be stopped from Praxis`)
      return
    }
    if (busy) return
    setBusy(true)
    setNotice(`Stopping ${selected.id}…`)
    try {
      if (attachedRef.current?.id === selected.id) leaveAttached()
      await manager.stop(selected.id)
      setNotice(`Stopped ${selected.id}`)
      await refresh()
    } catch (error) {
      setNotice(`Could not stop ${selected.id}: ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }, [agents, busy, leaveAttached, manager, refresh])

  const attachAgent = useCallback(
    (selected: TopLevelAgentSummary & { id: string }) => {
      if (attachedRef.current || busy) return
      const queue = createPromptQueue()
      const controller = new AbortController()
      const attached: AttachedAgent = { id: selected.id, queue, controller }
      attachedRef.current = attached
      setMode('attach')
      setAttachedId(selected.id)
      setAttachedOutput('')
      setNotice(`Attached to ${selected.id}`)
      void manager
        .attach(
          selected.id,
          queue.input,
          (text) =>
            setAttachedOutput((current) => trimOutput(`${current}${text}`)),
          controller.signal,
        )
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            setNotice(`Attach failed: ${errorMessage(error)}`)
          }
        })
        .finally(() => {
          if (attachedRef.current !== attached) return
          attachedRef.current = undefined
          setMode('list')
          setAttachedId(undefined)
          setAttachedOutput('')
          void refresh()
        })
    },
    [busy, manager, refresh],
  )

  const attachSelected = useCallback(() => {
    const selected = agents[selectedIndexRef.current]
    if (!selected) {
      setNotice('Type a task, then press Enter to start a background agent')
    } else if (isAttachable(selected)) {
      attachAgent(selected)
    } else {
      setNotice(`${agentKey(selected)} cannot be attached locally`)
    }
  }, [agents, attachAgent])

  const reviewSelected = useCallback(async () => {
    const selected = agents[selectedIndexRef.current]
    if (!selected || busy) return
    setBusy(true)
    setMode('review')
    setReviewAgent(selected)
    setAttachedOutput('Loading review…')
    try {
      if (!manager.review) throw new Error('Agent review unavailable')
      setAttachedOutput(trimOutput(await manager.review(selected)))
      setNotice(
        selected.id === undefined && isActive(selected)
          ? 'Native Claude session is read-only; attach unavailable'
          : `Reviewing ${agentKey(selected)}; enter a prompt to resume`,
      )
    } catch (error) {
      setAttachedOutput('')
      setNotice(`Could not load review: ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }, [agents, busy, manager])

  const resumeReview = useCallback(async () => {
    const selected = reviewAgent
    const prompt = inputRef.current.trim()
    if (!selected || !prompt || busy) return
    if (selected.id === undefined && isActive(selected)) {
      setNotice('Native Claude session is read-only while active')
      return
    }
    setBusy(true)
    try {
      const launched = await manager.launch({
        prompt,
        argv: [...defaults.argv, '--resume', selected.sessionId, '--', prompt],
        resumeSessionId: selected.sessionId,
        cwd: selected.cwd,
      })
      inputRef.current = ''
      setInput('')
      setReviewAgent(undefined)
      setNotice(`Resumed ${launched.id}`)
      selectedKeyRef.current = launched.id
      await refresh()
      attachAgent({
        id: launched.id,
        cwd: selected.cwd,
        kind: 'background',
        startedAt: Date.now(),
        sessionId: launched.sessionId,
        name: selected.name,
        status: 'active',
        state: 'working',
      })
    } catch (error) {
      setNotice(`Could not resume agent: ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }, [attachAgent, busy, defaults.argv, manager, refresh, reviewAgent])

  useInput((value, key) => {
    if ((key.ctrl && value.toLowerCase() === 'c') || value === '\u0003') {
      leaveAttached()
      onCancel?.()
      exit()
      return
    }
    if ((key.ctrl && value.toLowerCase() === 'x') || value === '\u0018') {
      void stopSelected()
      return
    }
    if (value === '?') {
      setShowHelp((current) => !current)
      return
    }
    const editInput = () => {
      if (key.backspace || key.delete) {
        inputRef.current = inputRef.current.slice(0, -1)
        setInput(inputRef.current)
      } else if (!key.ctrl && !key.meta && value) {
        inputRef.current += value
        setInput(inputRef.current)
      }
    }
    if (mode === 'attach') {
      if (key.escape) {
        leaveAttached()
      } else if (key.return) {
        const prompt = inputRef.current.trim()
        if (!prompt) return
        attachedRef.current?.queue.push(`${prompt}\n`)
        inputRef.current = ''
        setInput('')
      } else editInput()
      return
    }
    if (mode === 'review') {
      if (key.escape) {
        leaveReview()
      } else if (key.return) {
        void resumeReview()
      } else editInput()
      return
    }
    if ((key.ctrl && value.toLowerCase() === 'r') || value === '\u0012') {
      void refresh()
      return
    }
    if (key.upArrow) {
      const next = Math.max(0, selectedIndexRef.current - 1)
      selectedIndexRef.current = next
      selectedKeyRef.current = agents[next] ? agentKey(agents[next]) : undefined
      setSelectedIndex(next)
      return
    }
    if (key.downArrow) {
      const next = Math.min(agents.length - 1, selectedIndexRef.current + 1)
      selectedIndexRef.current = Math.max(0, next)
      const selectedAgent = agents[selectedIndexRef.current]
      selectedKeyRef.current = selectedAgent
        ? agentKey(selectedAgent)
        : undefined
      setSelectedIndex(selectedIndexRef.current)
      return
    }
    if (key.return) {
      if (inputRef.current.trim()) void launch()
      else {
        const current = agents[selectedIndexRef.current]
        if (current && isAttachable(current)) attachSelected()
        else void reviewSelected()
      }
      return
    }
    if (key.escape) {
      if (inputRef.current) {
        inputRef.current = ''
        setInput('')
      } else {
        exit()
      }
      return
    }
    editInput()
  })

  const selected = agents[selectedIndex]
  return (
    <Box flexDirection="column">
      <Text bold color={palette.accent}>
        Praxis agents
      </Text>
      <Text dimColor>{agents.length} sessions · live refresh</Text>
      {DASHBOARD_SECTIONS.map((title) => (
        <AgentSection
          key={title}
          title={title}
          agents={agents.filter((agent) => sectionFor(agent) === title)}
          {...(selected === undefined ? {} : { selected })}
        />
      ))}
      {mode === 'attach' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>Attached to {attachedId}</Text>
          {attachedOutput ? (
            <Text>{attachedOutput}</Text>
          ) : (
            <Text dimColor>Waiting for output…</Text>
          )}
          <Text>› {input}</Text>
          <Text dimColor>Enter sends · Esc detaches · Ctrl+C exits</Text>
        </Box>
      ) : mode === 'review' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>Reviewing {reviewAgent ? agentKey(reviewAgent) : ''}</Text>
          <Text>{attachedOutput || 'No review output.'}</Text>
          <Text>› {input}</Text>
          <Text dimColor>Enter resumes with prompt · Esc returns to list</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text>› {input || 'describe a task for a new background agent'}</Text>
          <Text dimColor>
            Enter dispatches · ↑/↓ select · Enter empty attaches · Ctrl+X stops
            · Ctrl+R refreshes · ? help · Esc exits
          </Text>
          {selected ? (
            <Text dimColor>Selected {agentKey(selected)}</Text>
          ) : null}
        </Box>
      )}
      {busy ? <Text dimColor>Working…</Text> : null}
      {notice ? <Text color={palette.warning}>{notice}</Text> : null}
      {showHelp ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Shortcuts</Text>
          <Text>
            Enter dispatches or attaches · Esc detaches/exits · Ctrl+X stops
            local background agents · Ctrl+R refreshes · ? closes help
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

export async function runAgentsDashboard(
  options: {
    manager: AgentsDashboardManager
    defaults: AgentsDashboardDefaults
    signal?: AbortSignal
  },
  dependencies: {
    loadThemeSettings?: () => Promise<TuiThemeSettings>
    renderDashboard?: (
      element: ReactElement,
      options: { exitOnCtrlC: boolean },
    ) => { waitUntilExit(): Promise<void> }
  } = {},
): Promise<number> {
  const controller = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal
  let settings = DEFAULT_TUI_THEME_SETTINGS
  try {
    settings = await (dependencies.loadThemeSettings ?? loadTuiThemeSettings)()
  } catch {
    // A corrupt shared settings file must not make the standalone dashboard unusable.
  }
  const instance = (dependencies.renderDashboard ?? render)(
    <TuiThemeProvider settings={settings}>
      <AgentsDashboardApp
        manager={options.manager}
        defaults={options.defaults}
        signal={signal}
        onCancel={() => controller.abort()}
      />
    </TuiThemeProvider>,
    { exitOnCtrlC: false },
  )
  await instance.waitUntilExit()
  return signal.aborted ? 130 : 0
}
