import {
  createQuietFrameRow,
  type QuietFrameDensity,
  type QuietFrameRow,
} from './quiet-frame.js'
import type { TuiHelpSurfaceModel } from './help-surface-model.js'
import type { TuiDiffSurfaceModel } from './diff-surface-model.js'
import type { TuiMcpSurfaceModel } from './mcp-surface-model.js'
import { tuiMcpServerActions } from './mcp-panel-projector.js'
import type { TuiTaskSurfaceModel } from './task-surface-model.js'
import type { TuiListSurfaceModel } from './list-surface-model.js'
import type { TuiBtwSurfaceModel } from './btw-surface-model.js'
import type { TuiRewindSurfaceModel } from './rewind-surface-model.js'

export type QuietOperationalSurface =
  | TuiHelpSurfaceModel
  | TuiDiffSurfaceModel
  | TuiMcpSurfaceModel
  | TuiTaskSurfaceModel
  | TuiListSurfaceModel
  | TuiBtwSurfaceModel
  | TuiRewindSurfaceModel

export interface QuietOperationalProjectionOptions {
  readonly density: QuietFrameDensity
  readonly screenReader?: boolean
  readonly maxItems?: number
  readonly nowMs?: number
}

const full = (d: QuietFrameDensity) => d === 'full' || d === 'standard'
const text = (v: unknown, fallback = '') =>
  typeof v === 'string' ? v.replace(/\s+/gu, ' ').trim() : fallback
const limit = (o: QuietOperationalProjectionOptions) =>
  Number.isInteger(o.maxItems) && (o.maxItems as number) > 0
    ? (o.maxItems as number)
    : 20
const marker = (selected: boolean, label: string, sr: boolean) =>
  sr
    ? `${selected ? 'Selected' : 'Option'}: ${label}`
    : `${selected ? '❯ ' : '  '}${label}`
const row = (
  key: string,
  value: string,
  role: Parameters<typeof createQuietFrameRow>[3] = 'body',
  sr?: string,
) => createQuietFrameRow(key, value, 'focus', role, sr)
const footer = (visual: string, accessible: string, sr: boolean) =>
  row('quiet:operational:footer', sr ? accessible : visual, 'muted', accessible)
const statusRole = (s: string): Parameters<typeof createQuietFrameRow>[3] =>
  /fail|error|denied/iu.test(s)
    ? 'error'
    : /running|answer|fork|auth|warn|retry/iu.test(s)
      ? 'warning'
      : /complete|connected|success|pass/iu.test(s)
        ? 'success'
        : 'muted'
const statusInfo = (s: string) => ({
  marker: /fail|error/iu.test(s)
    ? '!'
    : /running|answer|fork|auth|warn|retry/iu.test(s)
      ? '…'
      : /complete|connected|success|pass/iu.test(s)
        ? '✓'
        : '○',
  role: statusRole(s),
  label: /fail|error/iu.test(s)
    ? 'failed'
    : /running|answer|fork/iu.test(s)
      ? 'in progress'
      : /auth|warn|retry/iu.test(s)
        ? 'needs attention'
        : /complete|connected|success|pass/iu.test(s)
          ? 'complete'
          : /disabled|stopped|interrupted/iu.test(s)
            ? 'stopped'
            : 'neutral',
})
const normalizedIndex = (value: number, fallback = 0) =>
  Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback
const selectionWindow = (
  count: number,
  selected: number,
  size: number,
  preferred = 0,
) => {
  if (!count) return { start: 0, end: 0 }
  const n = Math.max(1, Math.trunc(size))
  const index = Math.min(count - 1, normalizedIndex(selected))
  const lastStart = Math.max(0, count - n)
  let start = Math.min(lastStart, normalizedIndex(preferred))
  if (index < start) start = index
  if (index >= start + n) start = index - n + 1
  start = Math.max(0, Math.min(lastStart, start))
  return { start, end: Math.min(count, start + n) }
}
const excerpt = (v: unknown, n = 180) => text(v).slice(0, n)
const boundedLines = (v: unknown, max: number, start = 0) => {
  if (typeof v !== 'string')
    return {
      lines: [] as { sourceIndex: number; text: string }[],
      truncated: false,
    }
  const source = v.slice(0, 32768)
  const lines: { sourceIndex: number; text: string }[] = []
  const requestedStart = normalizedIndex(start)
  const requestedCount = Math.max(1, Math.trunc(max))
  let sourceIndex = 0
  let cursor = 0
  let moreSource = false
  while (cursor <= source.length) {
    const newline = source.indexOf('\n', cursor)
    const end = newline === -1 ? source.length : newline
    const value = source.slice(cursor, end).replace(/\r$/u, '')
    if (sourceIndex >= requestedStart) {
      lines.push({ sourceIndex, text: value })
      if (lines.length >= requestedCount) {
        moreSource = newline !== -1
        break
      }
    }
    if (newline === -1) break
    cursor = newline + 1
    sourceIndex += 1
  }
  return { lines, truncated: v.length > source.length || moreSource }
}
const boundedRows = <T>(
  result: { readonly lines: readonly T[]; readonly truncated: boolean },
  max: number,
) =>
  result.truncated && result.lines.length >= max
    ? result.lines.slice(0, Math.max(0, max - 1))
    : result.lines
const actionFooter = (
  actions: readonly {
    readonly visualLabel?: string
    readonly screenReaderLabel: string
  }[],
  cancellation: {
    readonly visualLabel: string
    readonly screenReaderLabel: string
  },
) => ({
  visual: [
    ...actions.flatMap((action) =>
      action.visualLabel ? [action.visualLabel] : [],
    ),
    cancellation.visualLabel,
  ].join('  '),
  accessible: [
    ...actions.map((action) => action.screenReaderLabel),
    cancellation.screenReaderLabel,
  ].join('. '),
})
const mcpActionLabel = (
  action: ReturnType<typeof tuiMcpServerActions>[number],
) =>
  action.type === 'view-tools'
    ? 'View tools'
    : action.type === 'reconnect'
      ? 'Reconnect'
      : action.type === 'authenticate'
        ? 'Authenticate'
        : action.type === 'set-enabled'
          ? action.enabled
            ? 'Enable'
            : 'Disable'
          : 'Close'
const unsupported = (v: never): never => {
  throw new Error(`Unsupported quiet operational surface: ${String(v)}`)
}

function help(
  s: TuiHelpSurfaceModel,
  o: QuietOperationalProjectionOptions,
): QuietFrameRow[] {
  const sr = !!o.screenReader
  const out = [
    row(
      'quiet:help:heading',
      `Help · ${s.activeTab.label}`,
      'heading',
      `Help, ${s.activeTab.label} tab`,
    ),
  ]
  if (s.activeContent.kind === 'general') {
    out.push(
      ...(full(o.density)
        ? [
            row(
              'quiet:help:description',
              excerpt(s.activeContent.description),
              'muted',
            ),
          ]
        : []),
    )
    const shortcuts = s.activeContent.shortcutGroups.flatMap(
      (group) => group.shortcuts,
    )
    for (const x of shortcuts.slice(0, limit(o)))
      out.push(
        row(
          `quiet:help:shortcut:${x.id}`,
          marker(false, `${x.key} ${x.description}`, sr),
          'body',
          sr ? `Option: ${x.key} ${x.description}` : undefined,
        ),
      )
  } else {
    out.push(
      row('quiet:help:content-heading', s.activeContent.heading, 'muted'),
    )
    const window = selectionWindow(
      s.activeContent.commands.length,
      s.activeContent.focusedIndex ?? 0,
      limit(o),
    )
    const items = s.activeContent.commands.slice(window.start, window.end)
    const selected = Math.max(
      0,
      Math.min(
        s.activeContent.commands.length - 1,
        s.activeContent.focusedIndex ?? 0,
      ),
    )
    for (const [i, x] of items.entries()) {
      const yes = i + window.start === selected
      out.push(
        row(
          `quiet:help:command:${x.id}`,
          marker(
            yes,
            full(o.density)
              ? `${x.invocation} — ${excerpt(x.description)}`
              : x.invocation,
            sr,
          ),
          yes ? 'selection' : 'body',
          sr
            ? `${yes ? 'Selected' : 'Option'}: ${x.invocation} ${x.description}`
            : undefined,
        ),
      )
    }
    if (!items.length)
      out.push(row('quiet:help:empty', s.activeContent.emptyText, 'muted'))
  }
  if (full(o.density))
    out.push(
      row(
        'quiet:help:documentation',
        `${s.documentation.label}: ${s.documentation.url}`,
        'muted',
      ),
    )
  out.push(
    footer(
      '←/→ tabs  ↑/↓ browse  Esc close',
      'Use left and right arrows to switch tabs. Use up and down arrows to browse. Press Escape to close.',
      sr,
    ),
  )
  return out
}

function diff(
  s: TuiDiffSurfaceModel,
  o: QuietOperationalProjectionOptions,
): QuietFrameRow[] {
  const out = [row('quiet:diff:heading', s.title, 'heading')]
  const sr = !!o.screenReader
  const selectedSource = Math.max(
    0,
    s.sourceTabs.findIndex((source) => source.selected),
  )
  const sourceWindow = selectionWindow(
    s.sourceTabs.length,
    selectedSource,
    limit(o),
  )
  for (const t of s.sourceTabs.slice(sourceWindow.start, sourceWindow.end))
    out.push(
      row(
        `quiet:diff:source:${t.id}`,
        marker(t.selected, t.label, sr),
        t.selected ? 'selection' : 'body',
        sr
          ? `${t.selected ? 'Selected' : 'Option'}: source ${t.label}`
          : undefined,
      ),
    )
  if (s.view.kind === 'summary') {
    out.push(
      row(
        'quiet:diff:totals',
        `Totals: +${s.view.totals.additions} −${s.view.totals.deletions}`,
        'muted',
      ),
    )
    const window = selectionWindow(
      s.view.files.length,
      s.view.selectedIndex ?? 0,
      limit(o),
    )
    for (const [i, f] of s.view.files
      .slice(window.start, window.end)
      .entries()) {
      const yes = i + window.start === s.view.selectedIndex
      out.push(
        row(
          `quiet:diff:file:${f.id}`,
          marker(yes, `${f.path} (+${f.additions}/−${f.deletions})`, sr),
          yes ? 'selection' : 'body',
          sr
            ? `${yes ? 'Selected' : 'Option'}: ${f.path}, plus ${f.additions} additions and ${f.deletions} deletions`
            : undefined,
        ),
      )
    }
    if (!s.view.files.length)
      out.push(row('quiet:diff:empty', s.view.emptyText, 'muted'))
    const labels = actionFooter(s.view.actions, s.view.cancellation)
    out.push(footer(labels.visual, labels.accessible, sr))
  } else {
    out.push(
      row(
        `quiet:diff:file:${s.view.file.id}`,
        `${s.view.file.path} (+${s.view.file.additions}/−${s.view.file.deletions})`,
        'selection',
      ),
    )
    for (const p of s.view.patchRows.slice(0, limit(o)))
      out.push(
        row(
          `quiet:diff:patch:${p.id}`,
          p.text,
          p.kind === 'added'
            ? 'diffAdded'
            : p.kind === 'removed'
              ? 'diffRemoved'
              : 'body',
        ),
      )
    if (!s.view.patchRows.length)
      out.push(row('quiet:diff:empty', s.view.emptyPatchText, 'muted'))
    const labels = actionFooter(s.view.actions, s.view.cancellation)
    out.push(footer(labels.visual, labels.accessible, sr))
  }
  return out
}

function mcp(
  s: TuiMcpSurfaceModel,
  o: QuietOperationalProjectionOptions,
): QuietFrameRow[] {
  const { model, state } = s
  const out = [row('quiet:mcp:heading', 'MCP servers', 'heading')]
  const server = model.servers[state.serverIndex]
  const sr = !!o.screenReader
  if (state.depth === 'list') {
    const window = selectionWindow(
      model.servers.length,
      state.serverIndex,
      limit(o),
    )
    for (const [i, x] of model.servers
      .slice(window.start, window.end)
      .entries()) {
      const yes = i + window.start === state.serverIndex
      const info = statusInfo(x.status)
      out.push(
        row(
          `quiet:mcp:server:${x.name}`,
          marker(yes, `${info.marker} ${x.name} · ${x.status}`, sr),
          yes ? info.role : info.role,
          sr
            ? `${yes ? 'Selected' : 'Option'}: ${x.name}, ${info.label}`
            : undefined,
        ),
      )
    }
    if (!model.servers.length)
      out.push(row('quiet:mcp:empty', 'No MCP servers configured.', 'muted'))
    out.push(
      footer(
        '↑/↓ select  Enter open  Esc close',
        'Use up and down arrows to select. Press Enter to open. Press Escape to close.',
        sr,
      ),
    )
    return out
  }
  if (!server)
    return [
      ...out,
      row('quiet:mcp:empty', 'No MCP server selected.', 'muted'),
      footer('Esc back', 'Press Escape to go back.', sr),
    ]
  const serverInfo = statusInfo(server.status)
  out.push(
    row(
      `quiet:mcp:server:${server.name}`,
      `${serverInfo.marker} ${server.name} · ${server.status}`,
      serverInfo.role,
      sr ? `Selected: ${server.name}, ${serverInfo.label}` : undefined,
    ),
  )
  if (state.depth === 'detail') {
    if (full(o.density))
      out.push(
        row(
          `quiet:mcp:meta:${server.name}`,
          `${server.transport} · ${server.scope} · ${server.location}`,
          'muted',
        ),
      )
    const acts = tuiMcpServerActions(server)
    const window = selectionWindow(acts.length, state.selectedIndex, limit(o))
    acts.slice(window.start, window.end).forEach((a, visibleIndex) => {
      const actionIndex = visibleIndex + window.start
      const selected = actionIndex === state.selectedIndex
      const label = mcpActionLabel(a)
      out.push(
        row(
          `quiet:mcp:action:${server.name}:${a.type}`,
          marker(selected, label, sr),
          selected ? 'selection' : 'body',
          sr ? `${selected ? 'Selected' : 'Option'}: ${label}` : undefined,
        ),
      )
    })
    out.push(
      footer(
        '↑/↓ select  Enter choose  Esc back',
        'Use up and down arrows to select. Press Enter to choose. Press Escape to go back.',
        sr,
      ),
    )
    return out
  }
  const tools = server.tools ?? []
  if (state.depth === 'tools') {
    const window = selectionWindow(tools.length, state.selectedIndex, limit(o))
    for (const [i, t] of tools.slice(window.start, window.end).entries())
      out.push(
        row(
          `quiet:mcp:tool:${t.fullName}`,
          marker(i + window.start === state.selectedIndex, t.name, sr),
          i + window.start === state.selectedIndex ? 'selection' : 'body',
          sr
            ? `${i + window.start === state.selectedIndex ? 'Selected' : 'Option'}: ${t.name}`
            : undefined,
        ),
      )
    if (!tools.length)
      out.push(row('quiet:mcp:tools-empty', 'No tools available.', 'muted'))
    out.push(
      footer(
        '↑/↓ select  Enter view  Esc back',
        'Use up and down arrows to select. Press Enter to view. Press Escape to go back.',
        sr,
      ),
    )
    return out
  }
  const tool = tools[state.selectedIndex]
  if (tool) {
    out.push(row(`quiet:mcp:tool:${tool.fullName}`, tool.name, 'selection'))
    if (full(o.density))
      out.push(
        row(
          `quiet:mcp:tool-description:${tool.fullName}`,
          excerpt(tool.description, 240),
          'muted',
        ),
      )
  } else out.push(row('quiet:mcp:tool-empty', 'No tool selected.', 'muted'))
  out.push(footer('Esc back', 'Press Escape to go back.', sr))
  return out
}

function tasks(
  s: TuiTaskSurfaceModel,
  o: QuietOperationalProjectionOptions,
): QuietFrameRow[] {
  const out = [row('quiet:tasks:heading', 'Tasks', 'heading')]
  const sr = !!o.screenReader
  const list = s.tasks
  if (s.state.depth === 'list') {
    const window = selectionWindow(list.length, s.state.selectedIndex, limit(o))
    for (const [i, t] of list.slice(window.start, window.end).entries()) {
      const yes = i + window.start === s.state.selectedIndex
      const info = statusInfo(t.status)
      out.push(
        row(
          `quiet:task:${t.id}`,
          marker(
            yes,
            `${info.marker} ${t.kind} · ${t.status} · ${excerpt(t.label, 100)}`,
            sr,
          ),
          info.role,
          sr
            ? `${yes ? 'Selected' : 'Option'}: ${t.kind}, ${info.label}, ${t.label}`
            : undefined,
        ),
      )
    }
    if (!list.length) out.push(row('quiet:tasks:empty', 'No tasks.', 'muted'))
    out.push(
      footer(
        '↑/↓ select  Enter open  Esc close',
        'Use up and down arrows to select. Press Enter to open. Press Escape to close.',
        sr,
      ),
    )
    return out
  }
  const t = list[s.state.selectedIndex]
  if (!t)
    return [...out, row('quiet:tasks:empty', 'No task selected.', 'muted')]
  const info = statusInfo(t.status)
  out.push(
    row(
      `quiet:task:${t.id}`,
      `${info.marker} ${t.kind} · ${t.status} · ${t.command ?? t.label}`,
      info.role,
      sr
        ? `Selected: ${t.kind}, ${info.label}, ${t.command ?? t.label}`
        : undefined,
    ),
  )
  if (
    o.nowMs !== undefined &&
    Number.isFinite(o.nowMs) &&
    o.nowMs >= 0 &&
    t.status === 'running' &&
    t.startedAtMs !== undefined
  )
    out.push(
      row(
        `quiet:task:${t.id}:duration`,
        `Duration: ${Math.max(0, Math.floor((o.nowMs - t.startedAtMs) / 1000))} seconds`,
        'muted',
      ),
    )
  const output = boundedLines(
    t.output,
    limit(o),
    normalizedIndex(s.state.scrollOffset),
  )
  for (const line of boundedRows(output, limit(o)))
    out.push(
      row(
        `quiet:task:${t.id}:output:${line.sourceIndex}`,
        line.text,
        t.status === 'failed' ? 'error' : 'body',
      ),
    )
  if (output.truncated)
    out.push(row(`quiet:task:${t.id}:truncated`, 'Output truncated.', 'muted'))
  else if (output.lines.length === 0)
    out.push(
      row(`quiet:task:${t.id}:output:empty`, 'No output available.', 'muted'),
    )
  out.push(
    footer(
      t.status === 'running' ? 'Esc back  Stop task available' : 'Esc back',
      'Press Escape to go back.',
      sr,
    ),
  )
  return out
}

function list(
  s: TuiListSurfaceModel,
  o: QuietOperationalProjectionOptions,
): QuietFrameRow[] {
  const out = [row('quiet:list:heading', s.title, 'heading')]
  const sr = !!o.screenReader
  const occurrences = new Map<string, number>()
  const keys = s.rows.map((x) => {
    const occurrence = occurrences.get(x.label) ?? 0
    occurrences.set(x.label, occurrence + 1)
    return occurrence
  })
  const window = selectionWindow(s.rows.length, s.selectedIndex, limit(o))
  for (const [i, x] of s.rows.slice(window.start, window.end).entries()) {
    const actual = i + window.start
    const yes = actual === s.selectedIndex
    out.push(
      row(
        `quiet:list:${JSON.stringify([s.title, x.label, keys[actual]])}`,
        marker(
          yes,
          full(o.density) && x.description
            ? `${x.label} — ${excerpt(x.description)}`
            : x.label,
          sr,
        ),
        yes ? 'selection' : 'body',
        sr ? `${yes ? 'Selected' : 'Option'}: ${x.label}` : undefined,
      ),
    )
  }
  if (!s.rows.length) out.push(row('quiet:list:empty', s.emptyText, 'muted'))
  out.push(
    footer(
      '↑/↓ select  Enter open  Esc close',
      'Use up and down arrows to select. Press Enter to open. Press Escape to close.',
      sr,
    ),
  )
  return out
}

function btw(
  s: TuiBtwSurfaceModel,
  o: QuietOperationalProjectionOptions,
): QuietFrameRow[] {
  const out = [row('quiet:btw:heading', 'BTW', 'heading')]
  const sr = !!o.screenReader
  const window = selectionWindow(
    s.entries.length,
    s.selectedIndex,
    limit(o),
    normalizedIndex(s.scrollOffset),
  )
  for (const [i, e] of s.entries.slice(window.start, window.end).entries()) {
    const actual = i + window.start
    const info = statusInfo(e.status)
    const yes = actual === s.selectedIndex
    out.push(
      row(
        `quiet:btw:${e.id}`,
        marker(
          yes,
          `${info.marker} ${e.status} · ${excerpt(e.question, 120)}`,
          sr,
        ),
        info.role,
        sr
          ? `${yes ? 'Selected' : 'Option'}: ${e.question}, ${info.label}`
          : undefined,
      ),
    )
    if (yes && (e.error || (full(o.density) && e.answer))) {
      const detail = boundedLines(
        e.error ? `Error: ${e.error}` : e.answer,
        limit(o),
      )
      for (const line of boundedRows(detail, limit(o)))
        out.push(
          row(
            `quiet:btw:${e.id}:detail:${line.sourceIndex}`,
            line.text,
            e.error ? 'error' : 'body',
          ),
        )
      if (detail.truncated)
        out.push(
          row(`quiet:btw:${e.id}:truncated`, 'Answer truncated.', 'muted'),
        )
    }
  }
  if (!s.entries.length)
    out.push(row('quiet:btw:empty', 'No side questions.', 'muted'))
  if (s.copied) out.push(row('quiet:btw:copied', 'Copied.', 'success'))
  out.push(
    footer(
      '↑/↓ select  Enter open  Esc close',
      'Use up and down arrows to select. Press Enter to open. Press Escape to close.',
      sr,
    ),
  )
  return out
}

function rewind(
  s: TuiRewindSurfaceModel,
  o: QuietOperationalProjectionOptions,
): QuietFrameRow[] {
  const out = [row('quiet:rewind:heading', 'Rewind', 'heading')]
  const sr = !!o.screenReader
  if (s.view === 'points') {
    const start = Math.min(s.points.length, normalizedIndex(s.window.start))
    const end = Math.max(
      start,
      Math.min(s.points.length, normalizedIndex(s.window.end, start)),
    )
    const window = selectionWindow(
      end - start,
      s.selectedIndex - start,
      limit(o),
    )
    for (const [i, p] of s.points
      .slice(start + window.start, start + window.end)
      .entries()) {
      const actual = i + start + window.start
      const yes = actual === s.selectedIndex
      out.push(
        row(
          `quiet:rewind:${p.messageId}`,
          marker(yes, excerpt(p.prompt, 140), sr),
          yes ? 'selection' : 'body',
        ),
      )
    }
    if (!s.points.length)
      out.push(row('quiet:rewind:empty', 'No rewind points.', 'muted'))
    out.push(
      footer(
        '↑/↓ select  Enter choose  Esc close',
        'Use up and down arrows to select. Press Enter to choose. Press Escape to close.',
        sr,
      ),
    )
  } else if (s.view === 'confirm') {
    out.push(
      row(
        `quiet:rewind:${s.point.messageId}`,
        excerpt(s.point.prompt),
        'muted',
      ),
    )
    const window = selectionWindow(s.actions.length, s.selectedIndex, limit(o))
    for (const [visibleIndex, a] of s.actions
      .slice(window.start, window.end)
      .entries()) {
      const actionIndex = visibleIndex + window.start
      const selected = actionIndex === s.selectedIndex
      out.push(
        row(
          `quiet:rewind:action:${a.action}`,
          marker(selected, a.label, sr),
          a.action === 'cancel' ? (selected ? 'selection' : 'body') : 'warning',
          sr
            ? `${selected ? 'Selected' : 'Option'}: ${a.label}${a.action === 'cancel' ? '' : ', restores prior state'}`
            : undefined,
        ),
      )
    }
    if (!s.actions.length)
      out.push(row('quiet:rewind:actions-empty', 'No rewind actions.', 'muted'))
    out.push(
      footer(
        '↑/↓ select  Enter confirm  Esc back',
        'Use up and down arrows to select. Press Enter to confirm. Press Escape to go back.',
        sr,
      ),
    )
  } else {
    out.push(
      row(
        `quiet:rewind:${s.point.messageId}`,
        `${s.direction === 'from' ? 'From' : 'To'}: ${excerpt(s.point.prompt)}`,
        'muted',
      ),
    )
    const context = boundedLines(s.context, limit(o))
    for (const line of boundedRows(context, limit(o)))
      out.push(
        row(`quiet:rewind:context:${line.sourceIndex}`, line.text, 'body'),
      )
    if (context.truncated)
      out.push(
        row('quiet:rewind:context:truncated', 'Context truncated.', 'muted'),
      )
    else if (context.lines.length === 0)
      out.push(row('quiet:rewind:context:empty', 'No context.', 'muted'))
    out.push(footer('Esc back', 'Press Escape to go back.', sr))
  }
  return out
}

export function projectQuietOperationalRows(
  surface: QuietOperationalSurface,
  options: QuietOperationalProjectionOptions,
): readonly QuietFrameRow[] {
  switch (surface.kind) {
    case 'help':
      return help(surface, options)
    case 'diff':
      return diff(surface, options)
    case 'mcp-panel':
      return mcp(surface, options)
    case 'tasks-panel':
      return tasks(surface, options)
    case 'list-panel':
      return list(surface, options)
    case 'btw-panel':
      return btw(surface, options)
    case 'rewind-panel':
      return rewind(surface, options)
    default:
      return unsupported(surface)
  }
}
