import { useCallback, useEffect, useRef, useState } from 'react'

import { Box, Text, render, useApp, useInput } from 'ink'

import type { TopLevelAgentSummary } from '../application/top-level-agent-manager.js'

export interface AgentsDashboardManager {
  launch(options: {
    prompt: string
    argv: string[]
    cwd?: string
  }): Promise<{ id: string; sessionId: string }>
  list(options: { cwd?: string; all: boolean }): Promise<TopLevelAgentSummary[]>
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

type DashboardMode = 'list' | 'attach'

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

function agentStatus(agent: TopLevelAgentSummary): string {
  return agent.status ?? agent.state
}

function trimOutput(output: string): string {
  const limit = 16_000
  return output.length <= limit ? output : `…${output.slice(-limit)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function AgentsDashboardApp({
  manager,
  defaults,
  signal,
  refreshIntervalMs = 1_000,
  onCancel,
}: AgentsDashboardAppProps) {
  const { exit } = useApp()
  const [agents, setAgents] = useState<TopLevelAgentSummary[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedIndexRef = useRef(0)
  const [mode, setMode] = useState<DashboardMode>('list')
  const [attachedId, setAttachedId] = useState<string>()
  const [input, setInput] = useState('')
  const inputRef = useRef('')
  const [attachedOutput, setAttachedOutput] = useState('')
  const [notice, setNotice] = useState('Loading agents…')
  const [busy, setBusy] = useState(false)
  const attachedRef = useRef<AttachedAgent | undefined>(undefined)

  const refresh = useCallback(async () => {
    try {
      const next = await manager.list({
        all: true,
        ...(defaults.cwd === undefined ? {} : { cwd: defaults.cwd }),
      })
      setAgents(next)
      setSelectedIndex((current) => {
        const selected = Math.min(current, Math.max(0, next.length - 1))
        selectedIndexRef.current = selected
        return selected
      })
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
    if (!isActive(selected)) {
      setNotice(`${selected.id} is already completed`)
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

  const attachSelected = useCallback(() => {
    const selected = agents[selectedIndexRef.current]
    if (!selected) {
      setNotice('Type a task, then press Enter to start a background agent')
      return
    }
    if (!isActive(selected)) {
      setNotice(`${selected.id} is completed and cannot be attached`)
      return
    }
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
  }, [agents, busy, manager, refresh])

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
    if (mode === 'attach') {
      if (key.escape) {
        leaveAttached()
      } else if (key.return) {
        const prompt = inputRef.current.trim()
        if (!prompt) return
        attachedRef.current?.queue.push(`${prompt}\n`)
        inputRef.current = ''
        setInput('')
      } else if (key.backspace || key.delete) {
        inputRef.current = inputRef.current.slice(0, -1)
        setInput(inputRef.current)
      } else if (!key.ctrl && !key.meta && value) {
        inputRef.current += value
        setInput(inputRef.current)
      }
      return
    }
    if ((key.ctrl && value.toLowerCase() === 'r') || value === '\u0012') {
      void refresh()
      return
    }
    if (key.upArrow) {
      const next = Math.max(0, selectedIndexRef.current - 1)
      selectedIndexRef.current = next
      setSelectedIndex(next)
      return
    }
    if (key.downArrow) {
      const next = Math.min(agents.length - 1, selectedIndexRef.current + 1)
      selectedIndexRef.current = Math.max(0, next)
      setSelectedIndex(selectedIndexRef.current)
      return
    }
    if (key.return) {
      if (inputRef.current.trim()) void launch()
      else attachSelected()
      return
    }
    if (key.escape) {
      if (inputRef.current) {
        inputRef.current = ''
        setInput('')
      } else {
        onCancel?.()
        exit()
      }
      return
    }
    if (key.backspace || key.delete) {
      inputRef.current = inputRef.current.slice(0, -1)
      setInput(inputRef.current)
    } else if (!key.ctrl && !key.meta && value) {
      inputRef.current += value
      setInput(inputRef.current)
    }
  })

  const selected = agents[selectedIndex]
  const active = agents.filter(isActive)
  const completed = agents.length - active.length
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Praxis agents
      </Text>
      <Text dimColor>
        {active.length} active · {completed} completed · live refresh
      </Text>
      {agents.length === 0 ? (
        <Text dimColor>No background agents in this view.</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {agents.map((agent, index) => (
            <Text
              key={agent.id}
              {...(index === selectedIndex ? { color: 'cyan' } : {})}
            >
              {index === selectedIndex ? '› ' : '  '}
              {agent.name} · {agentStatus(agent)} · {agent.id}
            </Text>
          ))}
        </Box>
      )}
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
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text>› {input || 'describe a task for a new background agent'}</Text>
          <Text dimColor>
            Enter dispatches · ↑/↓ select · Enter with an empty task attaches ·
            Ctrl+X stops · Ctrl+R refreshes · Esc exits
          </Text>
          {selected ? <Text dimColor>Selected {selected.id}</Text> : null}
        </Box>
      )}
      {busy ? <Text dimColor>Working…</Text> : null}
      {notice ? <Text color="yellow">{notice}</Text> : null}
    </Box>
  )
}

export async function runAgentsDashboard(options: {
  manager: AgentsDashboardManager
  defaults: AgentsDashboardDefaults
  signal?: AbortSignal
}): Promise<number> {
  const controller = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal
  const instance = render(
    <AgentsDashboardApp
      manager={options.manager}
      defaults={options.defaults}
      signal={signal}
      onCancel={() => controller.abort()}
    />,
    { exitOnCtrlC: false },
  )
  await instance.waitUntilExit()
  return signal.aborted ? 130 : 0
}
