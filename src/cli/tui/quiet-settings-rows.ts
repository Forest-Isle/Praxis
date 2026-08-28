import {
  createQuietFrameRow,
  type QuietFrameDensity,
  type QuietFrameRow,
} from './quiet-frame.js'
import type { TuiDoctorSurfaceModel } from './doctor-surface-model.js'
import type { TuiMemorySurfaceModel } from './memory-surface-model.js'
import type { TuiHooksSurfaceModel } from './hooks-surface-model.js'
import type { TuiConfigSurfaceModel } from './config-surface-model.js'
import type { TuiSandboxSurfaceModel } from './sandbox-surface-model.js'
import type {
  TuiModelSurfaceModel,
  TuiEffortSurfaceModel,
} from './model-effort-surface-model.js'
import type { TuiThemeSurfaceModel } from './theme-surface-model.js'
import type { TuiLeafSurfaceModel } from './leaf-surface-model.js'
import {
  configSettingValue,
  CLAUDE_2_1_208_CONFIG_SETTINGS,
} from './config-settings.js'
import { formatCostSummary } from './cost-summary.js'

export type QuietSettingsSurface =
  | TuiDoctorSurfaceModel
  | TuiMemorySurfaceModel
  | TuiHooksSurfaceModel
  | TuiConfigSurfaceModel
  | TuiSandboxSurfaceModel
  | TuiModelSurfaceModel
  | TuiEffortSurfaceModel
  | TuiThemeSurfaceModel
  | TuiLeafSurfaceModel
export interface QuietSettingsProjectionOptions {
  readonly density: QuietFrameDensity
  readonly screenReader?: boolean
  readonly maxItems?: number
}
type Role = Parameters<typeof createQuietFrameRow>[3]
const full = (d: QuietFrameDensity) => d === 'full' || d === 'standard'
const max = (o: QuietSettingsProjectionOptions) =>
  Number.isInteger(o.maxItems) && (o.maxItems ?? 0) > 0
    ? (o.maxItems as number)
    : 20
const clean = (v: unknown) =>
  typeof v === 'string' ? v.slice(0, 32768).replace(/\s+/gu, ' ').trim() : ''
const excerpt = (v: unknown, length = 240) => clean(v).slice(0, length)
const row = (k: string, t: string, role: Role = 'body', a?: string) =>
  createQuietFrameRow(k, t, 'focus', role, a)
const selected = (yes: boolean, text: string, sr: boolean) =>
  sr ? `${yes ? 'Selected' : 'Option'}: ${text}` : `${yes ? '❯ ' : '  '}${text}`
const index = (n: number, i: number) =>
  n ? Math.max(0, Math.min(n - 1, Number.isFinite(i) ? Math.trunc(i) : 0)) : 0
function window(n: number, i: number, size: number) {
  if (!n) return [0, 0] as const
  const x = index(n, i)
  const start = Math.max(
    0,
    Math.min(Math.max(0, n - size), x - Math.floor(size / 2)),
  )
  return [start, Math.min(n, start + size)] as const
}
const footer = (visual: string, accessible: string, sr: boolean) =>
  row('quiet:settings:footer', sr ? accessible : visual, 'muted', accessible)
const unsupported = (v: never): never => {
  throw new Error(`Unsupported quiet settings surface: ${String(v)}`)
}
const statusRole = (s: string): Role =>
  /fail|error|denied|invalid/iu.test(s)
    ? 'error'
    : /warn|pending|running/iu.test(s)
      ? 'warning'
      : /pass|complete|ready|enabled/iu.test(s)
        ? 'success'
        : 'muted'
const marker = (s: string) =>
  /fail|error|denied/iu.test(s)
    ? '!'
    : /warn|pending|running/iu.test(s)
      ? '…'
      : /pass|complete|ready|enabled/iu.test(s)
        ? '✓'
        : '○'
const value = (v: unknown) =>
  typeof v === 'boolean'
    ? v
      ? 'On'
      : 'Off'
    : Array.isArray(v)
      ? excerpt(
          v
            .slice(0, 20)
            .map((item) => excerpt(item, 80))
            .join(', '),
        ) || 'none'
      : excerpt(v) || 'Not set'

const closeFooter = (sr: boolean) =>
  footer('Esc close', 'Press Escape to close this surface.', sr)

function doctor(
  s: TuiDoctorSurfaceModel,
  o: QuietSettingsProjectionOptions,
): QuietFrameRow[] {
  const out = [
    row(
      'quiet:doctor:heading',
      'Doctor · Diagnostics',
      'heading',
      'Doctor diagnostics',
    ),
  ]
  if (s.loading)
    out.push(
      row(
        'quiet:doctor:loading',
        '… Running diagnostics…',
        'warning',
        'Diagnostics in progress',
      ),
    )
  if (s.error)
    out.push(
      row(
        'quiet:doctor:error',
        `! ${clean(s.error)}`,
        'error',
        `Error: ${clean(s.error)}`,
      ),
    )
  const report = s.report
  if (!report) {
    out.push(
      row('quiet:doctor:empty', '○ No diagnostic report available', 'muted'),
      closeFooter(!!o.screenReader),
    )
    return out
  }
  out.push(
    row(
      'quiet:doctor:version',
      `Praxis ${clean(report.praxisVersion)}`,
      'muted',
    ),
  )
  out.push(
    row(
      'quiet:doctor:summary',
      `✓ ${report.summary.passed} passed · ! ${report.summary.failed} failed · ${report.summary.warnings} warnings`,
      report.summary.failed
        ? 'error'
        : report.summary.warnings
          ? 'warning'
          : 'success',
    ),
  )
  let checks = [...report.checks]
  if (o.density === 'minimal')
    checks.sort(
      (a, b) => (a.status === 'pass' ? 1 : 0) - (b.status === 'pass' ? 1 : 0),
    )
  for (const c of checks.slice(0, max(o)))
    out.push(
      row(
        `quiet:doctor:check:${c.id}`,
        `${marker(c.status)} ${c.id}: ${excerpt(c.summary)}`,
        statusRole(c.status),
        `${c.status === 'pass' ? 'Pass' : c.status === 'fail' ? 'Failure' : 'Warning'}: ${c.id}. ${excerpt(c.summary)}`,
      ),
    )
  out.push(closeFooter(!!o.screenReader))
  return out
}

function memory(
  s: TuiMemorySurfaceModel,
  o: QuietSettingsProjectionOptions,
): QuietFrameRow[] {
  const sr = !!o.screenReader
  const out = [
    row('quiet:memory:heading', 'Memory · Native data plane', 'heading'),
  ]
  out.push(
    row(
      'quiet:memory:auto',
      `${s.autoMemoryEnabled ? '✓' : '○'} Auto-memory ${s.autoMemoryEnabled ? 'enabled' : 'disabled'}`,
      s.autoMemoryEnabled ? 'success' : 'muted',
    ),
  )
  if (s.loading)
    out.push(row('quiet:memory:loading', '… Loading memory files', 'warning'))
  if (!s.entries.length) {
    out.push(row('quiet:memory:empty', '○ No memory entries', 'muted'))
    out.push(closeFooter(sr))
    return out
  }
  if (s.openedIndex !== null) {
    const e = s.entries[index(s.entries.length, s.openedIndex)]
    if (!e) return out
    if (e) {
      out.push(
        row(
          `quiet:memory:detail:${e.path}`,
          `${e.kind === 'folder' ? 'Folder' : 'File'} · ${excerpt(e.displayPath)}`,
          'body',
        ),
      )
      if (full(o.density) && e.annotation)
        out.push(
          row(
            `quiet:memory:annotation:${e.path}`,
            excerpt(e.annotation),
            'muted',
          ),
        )
    }
    out.push(
      footer('Esc back', 'Press Escape to go back to memory entries', sr),
    )
    return out
  }
  const [a, b] = window(s.entries.length, s.selectedIndex, max(o))
  for (let i = a; i < b; i++) {
    const e = s.entries[i]
    if (!e) continue
    const text = `${e.kind === 'folder' ? 'Folder' : 'File'} · ${excerpt(e.label || e.displayPath)}${full(o.density) && e.annotation ? ` — ${excerpt(e.annotation)}` : ''}`
    out.push(
      row(
        `quiet:memory:${e.path}`,
        selected(i === index(s.entries.length, s.selectedIndex), text, sr),
        i === index(s.entries.length, s.selectedIndex) ? 'selection' : 'body',
        `${i === index(s.entries.length, s.selectedIndex) ? 'Selected' : 'Option'}: ${text}`,
      ),
    )
  }
  out.push(
    footer(
      '↑/↓ browse  Enter open  Esc close',
      'Use Up and Down to browse. Press Enter to open. Escape closes.',
      sr,
    ),
  )
  return out
}

function hooks(
  s: TuiHooksSurfaceModel,
  o: QuietSettingsProjectionOptions,
): QuietFrameRow[] {
  const sr = !!o.screenReader
  const c = s.configuration
  const out = [
    row('quiet:hooks:heading', `Hooks · ${s.depth}`, 'heading'),
    row('quiet:hooks:notice', '○ Read-only hook settings', 'muted'),
  ]
  const ev = c.events[index(c.events.length, s.eventIndex)]
  if (!ev) {
    out.push(
      row('quiet:hooks:empty', '○ No hooks configured', 'muted'),
      closeFooter(sr),
    )
    return out
  }
  if (s.depth === 'events') {
    const [start, end] = window(c.events.length, s.eventIndex, max(o))
    for (let i = start; i < end; i++) {
      const e = c.events[i]
      if (!e) continue
      const isSelected = i === index(c.events.length, s.eventIndex)
      const label = `${e.name}${full(o.density) ? ` — ${excerpt(e.description)}` : ''}`
      out.push(
        row(
          `quiet:hooks:event:${e.name}`,
          selected(isSelected, label, sr),
          isSelected ? 'selection' : 'body',
          `${isSelected ? 'Selected' : 'Option'}: ${label}`,
        ),
      )
    }
  } else {
    out.push(
      row(
        `quiet:hooks:event:${ev.name}`,
        `Event · ${ev.name} — ${excerpt(ev.description)}`,
        'muted',
      ),
    )
    const m = ev.matchers[index(ev.matchers.length, s.matcherIndex)]
    if (s.depth === 'matchers') {
      const [start, end] = window(ev.matchers.length, s.matcherIndex, max(o))
      for (let i = start; i < end; i++) {
        const x = ev.matchers[i]
        if (!x) continue
        const isSelected = i === index(ev.matchers.length, s.matcherIndex)
        const label = `${x.scopeLabel}: ${excerpt(x.matcher) || 'All tools'}`
        out.push(
          row(
            `quiet:hooks:matcher:${ev.name}:${x.scope}:${x.matcher}`,
            selected(isSelected, label, sr),
            isSelected ? 'selection' : 'body',
            `${isSelected ? 'Selected' : 'Option'}: ${label}`,
          ),
        )
      }
      if (!ev.matchers.length)
        out.push(row('quiet:hooks:matchers:empty', '○ No matchers', 'muted'))
    } else if (m) {
      out.push(
        row(
          `quiet:hooks:matcher:${ev.name}:${m.scope}:${m.matcher}`,
          `Matcher · ${m.scopeLabel}: ${excerpt(m.matcher) || 'All tools'}`,
          'muted',
        ),
      )
      if (s.depth === 'hooks') {
        const [start, end] = window(m.hooks.length, s.hookIndex, max(o))
        for (let i = start; i < end; i++) {
          const h = m.hooks[i]
          if (!h) continue
          const isSelected = i === index(m.hooks.length, s.hookIndex)
          const label = `${h.type} · ${h.scopeLabel} · ${excerpt(h.path)}`
          out.push(
            row(
              `quiet:hooks:hook:${h.path}:${h.type}`,
              selected(isSelected, label, sr),
              isSelected ? 'selection' : 'body',
              `${isSelected ? 'Selected' : 'Option'}: ${label}`,
            ),
          )
        }
        if (!m.hooks.length)
          out.push(row('quiet:hooks:hooks:empty', '○ No hooks', 'muted'))
      } else {
        const h = m.hooks[index(m.hooks.length, s.hookIndex)]
        if (h)
          out.push(
            row(
              `quiet:hooks:hook:${h.path}:${h.type}`,
              `Hook · ${h.type} · ${h.scopeLabel} · ${excerpt(h.path)}`,
              'body',
            ),
          )
        else
          for (const [detailIndex, d] of ev.detail.slice(0, max(o)).entries())
            out.push(
              row(
                `quiet:hooks:detail:${ev.name}:${detailIndex}`,
                excerpt(d),
                'muted',
              ),
            )
      }
    } else
      out.push(
        row(
          `quiet:hooks:${s.depth}:empty`,
          s.depth === 'hooks' ? '○ No hooks' : '○ No hook details',
          'muted',
        ),
      )
  }
  out.push(
    footer(
      '↑/↓ browse  Enter open  Esc back',
      'Use Up and Down to browse. Press Enter to open. Escape goes back or closes.',
      sr,
    ),
  )
  return out
}

function config(
  s: TuiConfigSurfaceModel,
  o: QuietSettingsProjectionOptions,
): QuietFrameRow[] {
  const sr = !!o.screenReader
  const tabLabel =
    s.tab === 'status' ? 'Status' : s.tab === 'config' ? 'Config' : 'Usage'
  const out = [
    row('quiet:config:heading', `Settings · ${tabLabel}`, 'heading'),
    row(
      'quiet:config:tabs',
      ['Status', 'Config', 'Usage']
        .map((label) => (label === tabLabel ? `[${label}]` : label))
        .join('  '),
      'muted',
      `Current tab: ${tabLabel}`,
    ),
  ]
  if (s.tab === 'status') {
    const x = s.status
    if (!x) {
      out.push(
        row('quiet:config:status:empty', '○ No status available', 'muted'),
        footer(
          '←/→ tabs  Esc close',
          'Use Left and Right to change tabs. Press Escape to close.',
          sr,
        ),
      )
      return out
    }
    const fields: [string, unknown][] = [
      ['version', x.version],
      ['session', x.sessionName],
      ['session-id', x.sessionId],
      ['cwd', x.cwd],
      ['auth', x.authSource],
      ['base-url', x.baseUrl],
      ['proxy', x.proxy],
      ['mcp', x.mcpSummary],
      ['model', x.model],
      ['sources', x.settingSources.join(', ')],
    ]
    for (const [k, v] of fields.slice(0, max(o)))
      if (v !== undefined)
        out.push(row(`quiet:config:status:${k}`, `${k}: ${value(v)}`, 'body'))
    out.push(
      footer(
        '←/→ tabs  Esc close',
        'Use Left and Right to change tabs. Press Escape to close.',
        sr,
      ),
    )
    return out
  }
  if (s.tab === 'usage') {
    if (!s.usage)
      out.push(
        row(
          'quiet:config:usage:empty',
          '○ No usage summary available',
          'muted',
        ),
      )
    else {
      try {
        const source = formatCostSummary(s.usage).slice(0, 32768)
        const lines = source.split('\n')
        const truncated = lines.length > max(o)
        const visible = lines.slice(
          0,
          truncated ? Math.max(0, max(o) - 1) : max(o),
        )
        for (const [i, line] of visible.entries())
          out.push(row(`quiet:config:usage:${i}`, clean(line), 'body'))
        if (truncated)
          out.push(
            row('quiet:config:usage:truncated', '… Usage truncated', 'muted'),
          )
      } catch {
        out.push(
          row(
            'quiet:config:usage:error',
            '! Usage summary unavailable',
            'error',
          ),
        )
      }
    }
    out.push(
      footer(
        '←/→ tabs  Esc close',
        'Use Left and Right to change tabs. Press Escape to close.',
        sr,
      ),
    )
    return out
  }
  const q = excerpt(s.query).toLowerCase()
  const defs = CLAUDE_2_1_208_CONFIG_SETTINGS.filter(
    (d) =>
      !q ||
      d.label.toLowerCase().includes(q) ||
      d.nativeKey.toLowerCase().includes(q),
  )
  const [a, b] = window(defs.length, s.selectedIndex, max(o))
  for (let i = a; i < b; i++) {
    const d = defs[i]
    if (!d) continue
    const v = s.effectiveValues?.[d.id] ?? configSettingValue(s.snapshot, d)
    const t = `${d.label}: ${value(v)}`
    out.push(
      row(
        `quiet:config:setting:${d.id}`,
        selected(i === index(defs.length, s.selectedIndex), t, sr),
        i === index(defs.length, s.selectedIndex) ? 'selection' : 'body',
        `${i === index(defs.length, s.selectedIndex) ? 'Selected' : 'Option'}: ${t}`,
      ),
    )
  }
  if (!defs.length)
    out.push(row('quiet:config:empty', '○ No matching settings', 'muted'))
  out.push(
    row(
      'quiet:config:search',
      `Search: ${excerpt(s.query) || '(all settings)'}`,
      s.searchFocused ? 'input' : 'muted',
      s.searchFocused
        ? `Search input: ${excerpt(s.query) || 'all settings'}`
        : undefined,
    ),
  )
  out.push(
    footer(
      '←/→ tabs  / search  ↑/↓ browse  Enter change  Esc close',
      'Use Left and Right to change tabs. Press slash to search. Use Up and Down to browse. Press Enter to change. Press Escape to close.',
      sr,
    ),
  )
  return out
}

function sandbox(
  s: TuiSandboxSurfaceModel,
  o: QuietSettingsProjectionOptions,
): QuietFrameRow[] {
  const x = s.snapshot
  const sr = !!o.screenReader
  const out = [
    row('quiet:sandbox:heading', `Sandbox · ${s.tab}`, 'heading'),
    row(
      'quiet:sandbox:tab',
      `Current tab: ${s.tab}`,
      'muted',
      `Current tab: ${s.tab}`,
    ),
    row(
      'quiet:sandbox:support',
      `${x.supported ? '✓' : '!'} ${x.supported ? 'Supported' : 'Unavailable'} on ${x.platform}${x.unavailableReason ? `: ${excerpt(x.unavailableReason)}` : ''}`,
      x.supported ? 'success' : 'error',
      `${x.supported ? 'Supported' : 'Unavailable'} on ${x.platform}${x.unavailableReason ? `: ${excerpt(x.unavailableReason)}` : ''}`,
    ),
  ]
  if (s.tab === 'mode') {
    const modes = [
      ['auto-allow', 'Auto-allow'],
      ['regular', 'Regular permissions'],
      ['disabled', 'Disabled'],
    ] as const
    const current = x.settings.enabled
      ? x.settings.autoAllowBashIfSandboxed
        ? 'auto-allow'
        : 'regular'
      : 'disabled'
    const [start, end] = window(modes.length, s.selectedIndex, max(o))
    for (let i = start; i < end; i++) {
      const candidate = modes[i]
      if (!candidate) continue
      const [id, label] = candidate
      const isSelected = i === index(modes.length, s.selectedIndex)
      const optionText = `${label}${id === current ? ' (current)' : ''}`
      out.push(
        row(
          `quiet:sandbox:mode:${id}`,
          selected(isSelected, optionText, sr),
          isSelected ? 'selection' : 'body',
          `${isSelected ? 'Selected' : 'Option'}: ${label}${id === current ? ', current mode' : ''}`,
        ),
      )
    }
  } else if (s.tab === 'dependencies') {
    const d = x.dependencies as unknown as Record<string, unknown>
    const errors = (Array.isArray(d.errors) ? d.errors : [])
      .map((item) => excerpt(item))
      .filter(Boolean)
    const warnings = (Array.isArray(d.warnings) ? d.warnings : [])
      .map((item) => excerpt(item))
      .filter(Boolean)
    const diagnostics = [
      ...errors.map((message, sourceIndex) => ({
        key: `quiet:sandbox:dependency:error:${sourceIndex}`,
        text: `! ${message}`,
        role: 'error' as const,
        accessible: `Dependency error: ${message}`,
      })),
      ...warnings.map((message, sourceIndex) => ({
        key: `quiet:sandbox:dependency:warning:${sourceIndex}`,
        text: `… ${message}`,
        role: 'warning' as const,
        accessible: `Dependency warning: ${message}`,
      })),
    ]
    for (const item of diagnostics.slice(0, max(o)))
      out.push(row(item.key, item.text, item.role, item.accessible))
    if (!errors.length && !warnings.length && !x.unavailableReason)
      out.push(
        row('quiet:sandbox:ready', '✓ Sandbox dependencies ready', 'success'),
      )
  } else if (s.tab === 'overrides') {
    const items = [
      [
        'unsandboxed',
        'Allow unsandboxed fallback',
        x.settings.allowUnsandboxedCommands,
      ],
      ['strict', 'Strict sandbox mode', x.settings.failIfUnavailable],
    ] as const
    const [start, end] = window(items.length, s.selectedIndex, max(o))
    for (let i = start; i < end; i++) {
      const candidate = items[i]
      if (!candidate) continue
      const [id, label, on] = candidate
      const isSelected = i === index(items.length, s.selectedIndex)
      out.push(
        row(
          `quiet:sandbox:override:${id}`,
          selected(isSelected, `${label}${on ? ' (current)' : ''}`, sr),
          isSelected ? 'selection' : 'body',
          `${isSelected ? 'Selected' : 'Option'}: ${label}${on ? ', current' : ''}`,
        ),
      )
    }
  } else {
    const runtime = s.snapshot.settings.runtimeConfig as unknown as Record<
      string,
      unknown
    >
    const filesystem = (runtime.filesystem ?? {}) as Record<string, unknown>
    const network = (runtime.network ?? {}) as Record<string, unknown>
    const fields: readonly [string, unknown][] = [
      ['excluded commands', x.settings.excludedCommands],
      ['allow write', filesystem.allowWrite],
      ['deny write', filesystem.denyWrite],
      ['allow read', filesystem.allowRead],
      ['deny read', filesystem.denyRead],
      ['allow domains', network.allowedDomains],
      ['deny domains', network.deniedDomains],
    ]
    const warnings = (x.globPatternWarnings ?? []).map(
      (warning, warningIndex) => ({
        key: `quiet:sandbox:warning:${JSON.stringify([warningIndex, excerpt(warning, 120)])}`,
        text: `! Glob warning: ${excerpt(warning)}`,
        role: 'warning' as const,
        accessible: `Glob warning: ${excerpt(warning)}`,
      }),
    )
    const detail = fields.map(([key, fieldValue]) => ({
      key: `quiet:sandbox:config:${key}`,
      text: `${key}: ${Array.isArray(fieldValue) ? fieldValue.slice(0, max(o)).map(excerpt).join(', ') || 'none' : value(fieldValue)}`,
      role: 'body' as const,
      accessible: undefined,
    }))
    const projected = full(o.density) ? [...warnings, ...detail] : warnings
    for (const item of projected.slice(0, max(o)))
      out.push(row(item.key, item.text, item.role, item.accessible))
    if (projected.length === 0)
      out.push(
        row('quiet:sandbox:config:empty', '○ No sandbox overrides', 'muted'),
      )
  }
  out.push(
    footer(
      '←/→ tabs  ↑/↓ select  Enter confirm  Esc close',
      'Use Left and Right to change tabs. Use Up and Down to select. Press Enter to confirm. Press Escape to close sandbox settings.',
      sr,
    ),
  )
  return out
}

function optionsSurface(
  title: string,
  options: readonly {
    id?: string
    label: string
    description?: string
    model?: string
    selected?: boolean
  }[],
  selectedIndex: number,
  o: QuietSettingsProjectionOptions,
  extra?: string,
): QuietFrameRow[] {
  const sr = !!o.screenReader
  const out = [
    row(
      `quiet:${title}:heading`,
      (title.at(0) ?? '').toUpperCase() + title.slice(1),
      'heading',
    ),
  ]
  const occurrences = new Map<string, number>()
  const identities = options.map((option) => {
    const identity =
      excerpt(option.id || option.model || option.label) || 'option'
    const occurrence = occurrences.get(identity) ?? 0
    occurrences.set(identity, occurrence + 1)
    return JSON.stringify([identity, occurrence])
  })
  if (extra) out.push(row(`quiet:${title}:state`, excerpt(extra), 'muted'))
  const [a, b] = window(options.length, selectedIndex, max(o))
  for (let i = a; i < b; i++) {
    const x = options[i]
    if (!x) continue
    const identity = identities[i] ?? `option:${i}`
    const t = `${excerpt(x.label)}${x.selected ? ' (current)' : ''}${full(o.density) && x.description ? ` — ${excerpt(x.description)}` : ''}`
    out.push(
      row(
        `quiet:${title}:option:${identity}`,
        selected(i === index(options.length, selectedIndex), t, sr),
        title === 'theme-delete' && x.id === 'delete'
          ? 'error'
          : i === index(options.length, selectedIndex)
            ? 'selection'
            : 'body',
        `${i === index(options.length, selectedIndex) ? 'Selected' : 'Option'}: ${t}`,
      ),
    )
  }
  if (!options.length)
    out.push(row(`quiet:${title}:empty`, '○ No options available', 'muted'))
  out.push(
    footer(
      '↑/↓ browse  Enter select  Esc back',
      'Use Up and Down to browse. Press Enter to select. Escape goes back.',
      sr,
    ),
  )
  return out
}
function model(s: TuiModelSurfaceModel, o: QuietSettingsProjectionOptions) {
  return optionsSurface(
    'model',
    s.options,
    s.selectedIndex,
    o,
    `Effort: ${clean(s.effort)}`,
  )
}
function effort(s: TuiEffortSurfaceModel, o: QuietSettingsProjectionOptions) {
  return optionsSurface('effort', s.options, s.selectedIndex, o)
}
function theme(
  s: TuiThemeSurfaceModel,
  o: QuietSettingsProjectionOptions,
): QuietFrameRow[] {
  if (s.kind === 'theme-panel')
    return optionsSurface(
      'theme',
      s.options.map((option) => ({
        ...option,
        selected: option.current,
      })),
      s.selectedIndex,
      o,
      `${s.currentTheme}${s.syntaxHighlightingDisabled ? ' · Syntax highlighting disabled' : ''}`,
    )
  if (s.kind === 'custom-theme-create')
    return [
      row('quiet:theme:create:heading', 'Create custom theme', 'heading'),
      row('quiet:theme:create:base', `Base: ${s.base}`),
      row(
        'quiet:theme:create:name',
        `Name: ${excerpt(s.name) || '(enter name)'}`,
      ),
      footer(
        'Enter save  Esc back',
        'Press Enter to save. Escape goes back.',
        !!o.screenReader,
      ),
    ]
  if (s.kind === 'custom-theme-editor')
    return optionsSurface(
      'theme-editor',
      s.tokens.map((token) => ({
        id: token,
        label: token,
        description: s.theme.overrides[token] ?? 'Inherited from base',
      })),
      s.selectedIndex,
      o,
      `Theme: ${s.theme.name}`,
    )
  if (s.kind === 'custom-theme-token')
    return [
      row('quiet:theme:token:heading', `Theme token · ${s.token}`, 'heading'),
      row(
        `quiet:theme:token:${s.token}:value`,
        `Value: ${excerpt(s.value) || '(enter value)'}`,
      ),
      footer(
        'Enter save  Esc back',
        'Press Enter to save. Escape goes back.',
        !!o.screenReader,
      ),
    ]
  if (s.kind === 'custom-theme-delete')
    return optionsSurface(
      'theme-delete',
      [
        {
          id: 'delete',
          label: 'Delete theme',
          description: `Warning: permanently delete ${s.theme.name}`,
        },
        { id: 'cancel', label: 'Cancel', description: 'Keep this theme' },
      ],
      s.selectedIndex,
      o,
      '! Destructive action',
    )
  return unsupported(s)
}
function leaf(
  s: TuiLeafSurfaceModel,
  o: QuietSettingsProjectionOptions,
): QuietFrameRow[] {
  if (s.kind === 'model-input' || s.kind === 'export-filename')
    return [
      row(
        `quiet:leaf:${s.kind}:heading`,
        s.kind === 'model-input' ? 'Model input' : 'Export filename',
        'heading',
      ),
      row(`quiet:leaf:${s.kind}:value`, `Input: ${excerpt(s.value)}`, 'input'),
      footer(
        'Enter submit  Esc back',
        'Press Enter to submit. Escape goes back.',
        !!o.screenReader,
      ),
    ]
  if (s.kind === 'compact-progress') {
    const p = Math.max(
      0,
      Math.min(100, Number.isFinite(s.progress) ? s.progress : 0),
    )
    return [
      row('quiet:leaf:progress:heading', 'Compaction progress', 'heading'),
      row(
        'quiet:leaf:progress',
        `${p >= 100 ? '✓' : '…'} ${Math.round(p)}%`,
        p >= 100 ? 'success' : 'warning',
      ),
    ]
  }
  return optionsSurface(
    s.kind,
    s.options.map((x) => ({ ...x, id: x.id })),
    s.selectedIndex,
    o,
    s.kind === 'copy' && full(o.density)
      ? `Message age: ${Number.isFinite(s.messageAge) ? s.messageAge : 'unknown'}`
      : undefined,
  )
}

export function projectQuietSettingsRows(
  surface: QuietSettingsSurface,
  o: QuietSettingsProjectionOptions,
): readonly QuietFrameRow[] {
  switch (surface.kind) {
    case 'doctor-panel':
      return doctor(surface, o)
    case 'memory-panel':
      return memory(surface, o)
    case 'hooks-panel':
      return hooks(surface, o)
    case 'config-panel':
      return config(surface, o)
    case 'sandbox-panel':
      return sandbox(surface, o)
    case 'model-panel':
      return model(surface, o)
    case 'effort-panel':
      return effort(surface, o)
    case 'theme-panel':
    case 'custom-theme-create':
    case 'custom-theme-editor':
    case 'custom-theme-token':
    case 'custom-theme-delete':
      return theme(surface, o)
    case 'model-input':
    case 'export':
    case 'copy':
    case 'export-filename':
    case 'compact-progress':
      return leaf(surface, o)
    default:
      return unsupported(surface)
  }
}
