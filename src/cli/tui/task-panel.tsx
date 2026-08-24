import { Box, Text } from 'ink'

import type { BackgroundAgentSnapshot } from '../../application/background-agent-manager.js'
import type { BackgroundBashSnapshot } from '../../application/background-bash-manager.js'
import type { WorkflowTaskSnapshot } from '../../application/workflow-manager.js'
import type { TuiTaskSurfaceModel } from './task-surface-model.js'

export type TuiTaskKind = 'shell' | 'agent' | 'workflow'
export type TuiTaskStatus =
  'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'

export interface TuiTaskEntry {
  id: string
  kind: TuiTaskKind
  status: TuiTaskStatus
  label: string
  command?: string
  output?: string
  startedAtMs?: number
  durationMs?: number
  createdAtMs: number
}

export interface TuiTaskPanelState {
  depth: 'list' | 'detail'
  selectedIndex: number
  scrollOffset: number
}

export type TuiTaskPanelAction =
  | { type: 'move'; delta: -1 | 1 }
  | { type: 'open' }
  | { type: 'back' }
  | { type: 'scroll'; delta: -1 | 1 }

function requiredString(
  record: Readonly<Record<string, unknown>>,
  names: readonly string[],
): string {
  for (const name of names) {
    const value = record[name]
    if (typeof value === 'string' && value.trim()) return value
  }
  throw new Error(`Task record is missing ${names.join(' or ')}`)
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Task record has invalid ${name}`)
  }
  return value
}

function taskStatus(record: Readonly<Record<string, unknown>>): TuiTaskStatus {
  const status = record.status
  if (
    status === 'running' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'stopped' ||
    status === 'interrupted'
  ) {
    return status
  }
  if (status === 'error') return 'failed'
  if (status === 'killed' || status === 'cancelled') return 'stopped'
  throw new Error('Task record has invalid status')
}

export function projectBackgroundBashTask(
  snapshot: BackgroundBashSnapshot,
): TuiTaskEntry {
  return {
    id: snapshot.taskId,
    kind: 'shell',
    status: snapshot.status,
    label: snapshot.command,
    command: snapshot.command,
    output: snapshot.output,
    startedAtMs: snapshot.startedAt,
    ...(snapshot.durationMs === null
      ? {}
      : { durationMs: snapshot.durationMs }),
    createdAtMs: snapshot.startedAt,
  }
}

export function projectBackgroundAgentTask(
  snapshot: BackgroundAgentSnapshot,
): TuiTaskEntry {
  const status: TuiTaskStatus =
    snapshot.status === 'cancelled'
      ? 'stopped'
      : snapshot.status === 'orphaned'
        ? 'interrupted'
        : snapshot.status === 'queued' ||
            snapshot.status === 'waiting' ||
            snapshot.status === 'cancelling'
          ? 'running'
          : snapshot.status
  return {
    id: snapshot.agentId,
    kind: 'agent',
    status,
    label: snapshot.name ?? snapshot.description,
    output: snapshot.result?.text ?? snapshot.error ?? '',
    startedAtMs: snapshot.startedAt,
    ...(snapshot.durationMs === null
      ? {}
      : { durationMs: snapshot.durationMs }),
    createdAtMs: snapshot.startedAt,
  }
}

export function projectWorkflowTask(
  workflow: WorkflowTaskSnapshot | Readonly<Record<string, unknown>>,
): TuiTaskEntry {
  const record = workflow as Readonly<Record<string, unknown>>
  const result = record.result
  const error = typeof record.error === 'string' ? record.error : undefined
  const output =
    error ??
    (typeof result === 'string'
      ? result
      : result === undefined || result === null
        ? ''
        : JSON.stringify(result, null, 2))
  const startTime = optionalNumber(
    record.startTime ?? record.startedAt ?? record.started_at_ms,
    'startTime',
  )
  const durationMs = optionalNumber(
    record.durationMs ?? record.duration_ms,
    'durationMs',
  )
  return {
    id: requiredString(record, ['task_id', 'taskId', 'id']),
    kind: 'workflow',
    status: taskStatus(record),
    label: requiredString(record, [
      'summary',
      'description',
      'workflowName',
      'name',
    ]),
    output,
    ...(startTime === undefined ? {} : { startedAtMs: startTime }),
    ...(durationMs === undefined ? {} : { durationMs }),
    createdAtMs: startTime ?? 0,
  }
}

export function projectTuiTasks(input: {
  shells?: readonly BackgroundBashSnapshot[]
  agents?: readonly BackgroundAgentSnapshot[]
  workflows?: readonly WorkflowTaskSnapshot[]
}): readonly TuiTaskEntry[] {
  return [
    ...(input.shells ?? []).map(projectBackgroundBashTask),
    ...(input.agents ?? []).map(projectBackgroundAgentTask),
    ...(input.workflows ?? []).map(projectWorkflowTask),
  ].sort((left, right) => right.createdAtMs - left.createdAtMs)
}

/** Preserve selection by task identity across polling and task reordering. */
export function reconcileTuiTaskPanelState(
  state: TuiTaskPanelState,
  previousTasks: readonly TuiTaskEntry[],
  tasks: readonly TuiTaskEntry[],
): TuiTaskPanelState {
  const selectedId = previousTasks[state.selectedIndex]?.id
  const selectedIndex = selectedId
    ? tasks.findIndex(({ id }) => id === selectedId)
    : -1
  if (tasks.length === 0) {
    return { depth: 'list', selectedIndex: 0, scrollOffset: 0 }
  }
  if (selectedIndex >= 0) return { ...state, selectedIndex }
  return {
    depth: state.depth === 'detail' ? 'list' : state.depth,
    selectedIndex: Math.min(state.selectedIndex, tasks.length - 1),
    scrollOffset: 0,
  }
}

export function updateTuiTaskPanelState(
  state: TuiTaskPanelState,
  tasks: readonly TuiTaskEntry[],
  action: TuiTaskPanelAction,
): TuiTaskPanelState {
  if (tasks.length === 0) return initialTuiTaskPanelState(tasks)
  if (action.type === 'back') {
    return { ...state, depth: 'list', scrollOffset: 0 }
  }
  if (action.type === 'open') {
    return { ...state, depth: 'detail', scrollOffset: 0 }
  }
  if (action.type === 'scroll') {
    if (state.depth !== 'detail') return state
    return {
      ...state,
      scrollOffset: Math.max(0, state.scrollOffset + action.delta),
    }
  }
  if (state.depth !== 'list') return state
  return {
    ...state,
    selectedIndex: Math.min(
      tasks.length - 1,
      Math.max(0, state.selectedIndex + action.delta),
    ),
  }
}

export function initialTuiTaskPanelState(
  tasks: readonly TuiTaskEntry[],
): TuiTaskPanelState {
  return {
    depth: tasks.length === 1 ? 'detail' : 'list',
    selectedIndex: 0,
    scrollOffset: 0,
  }
}

function taskRuntime(task: TuiTaskEntry, nowMs: number): string {
  const milliseconds =
    task.status === 'running' && task.startedAtMs !== undefined
      ? Math.max(0, nowMs - task.startedAtMs)
      : (task.durationMs ?? 0)
  const seconds = Math.floor(milliseconds / 1_000)
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

function activeSummary(tasks: readonly TuiTaskEntry[]): string {
  const active = tasks.filter(({ status }) => status === 'running')
  const rows = active.length > 0 ? active : tasks
  const allShells = rows.every(({ kind }) => kind === 'shell')
  const noun = allShells ? (rows.length === 1 ? 'shell' : 'shells') : 'tasks'
  return `${rows.length} ${active.length > 0 ? 'active ' : ''}${noun}`
}

function detailTitle(kind: TuiTaskKind): string {
  switch (kind) {
    case 'shell':
      return 'Shell details'
    case 'agent':
      return 'Agent details'
    case 'workflow':
      return 'Workflow details'
  }
}

export function TaskPanel({
  surface,
  nowMs = Date.now(),
  screenReader = false,
  width = 80,
  height = 24,
}: {
  surface: TuiTaskSurfaceModel
  nowMs?: number
  screenReader?: boolean
  width?: number
  height?: number
}) {
  const { tasks, state } = surface
  const selectedIndex = Math.min(
    Math.max(0, state.selectedIndex),
    Math.max(0, tasks.length - 1),
  )
  const selected = tasks[selectedIndex]
  const listCapacity = Math.max(1, height - 4)
  let listStart = Math.min(
    Math.max(0, state.scrollOffset),
    Math.max(0, tasks.length - listCapacity),
  )
  if (selectedIndex < listStart) listStart = selectedIndex
  if (selectedIndex >= listStart + listCapacity) {
    listStart = selectedIndex - listCapacity + 1
  }
  const visibleTasks = tasks.slice(listStart, listStart + listCapacity)

  if (state.depth === 'detail' && selected) {
    const canStop = selected.status === 'running'
    const outputLines = (
      selected.output?.trim() || 'No output available'
    ).split('\n')
    const outputHeight = Math.max(1, height - 8)
    const scrollOffset = Math.min(
      Math.max(0, state.scrollOffset),
      Math.max(0, outputLines.length - outputHeight),
    )
    const visibleOutput = outputLines.slice(
      scrollOffset,
      scrollOffset + outputHeight,
    )
    const outputScrollable = outputLines.length > outputHeight
    return (
      <Box flexDirection="column" width={width}>
        <Text bold>{detailTitle(selected.kind)}</Text>
        <Text>Status: {selected.status}</Text>
        <Text>Runtime: {taskRuntime(selected, nowMs)}</Text>
        {selected.kind === 'shell' ? (
          <Text wrap="truncate-end">
            Command: {selected.command ?? selected.label}
          </Text>
        ) : (
          <Text wrap="truncate-end">Task: {selected.label}</Text>
        )}
        <Text>Output:</Text>
        {visibleOutput.map((line, index) => (
          <Text key={`${scrollOffset + index}-${line}`} wrap="truncate-end">
            {line}
          </Text>
        ))}
        <Text dimColor>
          {width < 50
            ? `${outputScrollable ? '↑/↓ scroll · ' : ''}← back${canStop ? ' · x stop' : ''}`
            : `${outputScrollable ? '↑/↓ to scroll · ' : ''}← to go back · Esc/Enter/Space to close${canStop ? ' · x to stop' : ''}`}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={width}>
      <Text bold>Background</Text>
      {tasks.length === 0 ? (
        <Text>No tasks currently running</Text>
      ) : (
        <>
          <Text>{activeSummary(tasks)}</Text>
          {visibleTasks.map((task, visibleIndex) => {
            const index = listStart + visibleIndex
            const selectedRow = index === selectedIndex
            return (
              <Text
                key={task.id}
                inverse={!screenReader && selectedRow}
                wrap="truncate-end"
              >
                {screenReader && selectedRow
                  ? 'Selected: '
                  : selectedRow
                    ? '❯  '
                    : '   '}
                {task.label} ({task.status})
              </Text>
            )
          })}
        </>
      )}
      <Text dimColor>
        {width < 50
          ? `↑/↓ select · Enter view${selected?.status === 'running' ? ' · x stop' : ''} · Esc`
          : `↑/↓ to select · Enter to view${selected?.status === 'running' ? ' · x to stop' : ''} · Esc to close`}
      </Text>
    </Box>
  )
}
