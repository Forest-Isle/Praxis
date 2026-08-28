import {
  createQuietFrameRow,
  type QuietFrameDensity,
  type QuietFrameRow,
} from './quiet-frame.js'
import type { TuiCommandPaletteModel } from './command-palette-model.js'
import type { TuiDecisionSurfaceModel } from './decision-surface-model.js'
import type { TuiElicitationSurfaceModel } from './mcp-elicitation-surface-model.js'
import type { TuiMentionPickerModel } from './mention-picker-model.js'
import type { TuiPermissionSurfaceModel } from './permission-surface-model.js'
import type { TuiSessionPickerModel } from './session-picker-model.js'
import type { TuiToolPermissionOption } from './tool-permission.js'

export type QuietPrioritySurface =
  | { readonly kind: 'editor-wait' }
  | { readonly kind: 'permission'; readonly surface: TuiPermissionSurfaceModel }
  | TuiDecisionSurfaceModel
  | {
      readonly kind: 'elicitation'
      readonly surface: TuiElicitationSurfaceModel
    }

export type QuietOverlaySurface =
  | TuiCommandPaletteModel
  | TuiMentionPickerModel
  | { readonly kind: 'exit-confirmation' }

export type QuietChoiceSurface =
  | QuietPrioritySurface
  | QuietOverlaySurface
  | TuiSessionPickerModel
  | TuiPermissionSurfaceModel

export interface QuietChoiceProjectionOptions {
  readonly density: QuietFrameDensity
  readonly screenReader?: boolean
}

const excerpt = (value: unknown, max = 160): string =>
  typeof value === 'string'
    ? value.replace(/\s+/gu, ' ').trim().slice(0, max)
    : ''
const detailAllowed = (density: QuietFrameDensity) =>
  density === 'full' || density === 'standard'
const row = (
  key: string,
  text: string,
  role: Parameters<typeof createQuietFrameRow>[3] = 'body',
  sr?: string,
) => createQuietFrameRow(key, text, 'focus', role, sr)
const footer = (
  screenReader: boolean,
  text = '↑/↓ select  Enter confirm  Esc cancel',
) =>
  row(
    'quiet:choice:footer',
    text,
    'muted',
    screenReader
      ? 'Use up and down arrows to select. Press Enter to confirm. Press Escape to cancel.'
      : undefined,
  )
const explicitFooter = (key: string, visual: string, accessible: string) =>
  row(key, visual, 'muted', accessible)
const marker = (selected: boolean, label: string, screenReader: boolean) =>
  screenReader
    ? selected
      ? `Selected: ${label}`
      : `Option: ${label}`
    : `${selected ? '❯ ' : '  '}${label}`
const excerptOption = (
  label: string,
  description: string | undefined,
  density: QuietFrameDensity,
) =>
  detailAllowed(density) && description
    ? `${label} — ${excerpt(description)}`
    : label
const unsupported = (value: never): never => {
  throw new Error(`Unsupported quiet choice surface: ${String(value)}`)
}

function optionsRows(
  options: readonly {
    readonly label: string
    readonly selected: boolean
    readonly index?: number
    readonly id?: string
    readonly description?: string
  }[],
  prefix: string,
  density: QuietFrameDensity,
  sr: boolean,
): QuietFrameRow[] {
  return options.map((item, index) =>
    row(
      `${prefix}:${item.id ?? item.index ?? index}`,
      marker(
        item.selected,
        excerptOption(item.label, item.description, density),
        sr,
      ),
      item.selected ? 'selection' : 'body',
      sr
        ? item.selected
          ? `Selected: ${item.label}`
          : `Option: ${item.label}`
        : undefined,
    ),
  )
}

function permission(
  surface: TuiPermissionSurfaceModel,
  density: QuietFrameDensity,
  sr: boolean,
): QuietFrameRow[] {
  const out: QuietFrameRow[] = []
  switch (surface.kind) {
    case 'tool-request': {
      out.push(
        row(
          'quiet:permission:heading',
          excerpt(surface.tool.question || surface.heading),
          'heading',
        ),
      )
      if (detailAllowed(density)) {
        for (const [key, value] of [
          ['subtitle', surface.tool.subtitle],
          ['explanation', surface.tool.explanation],
        ] as const)
          if (value)
            out.push(row(`quiet:permission:${key}`, excerpt(value), 'muted'))
        surface.tool.detail
          .slice(0, 20)
          .forEach((item, i) =>
            out.push(
              row(
                `quiet:permission:detail:${i}`,
                `${item.prefix ?? ' '} ${excerpt(item.text)}`,
                item.prefix === '-'
                  ? 'diffRemoved'
                  : item.prefix === '+'
                    ? 'diffAdded'
                    : 'body',
              ),
            ),
          )
      }
      out.push(
        ...optionsRows(
          surface.options.map((item, index) => ({
            ...item,
            label: permissionLabel({
              ...item,
              index: index + 1,
              selected: index === surface.selectedIndex,
            }),
            selected: index === surface.selectedIndex,
          })),
          'quiet:permission:option',
          density,
          sr,
        ),
      )
      if (surface.feedbackMode)
        out.push(
          row(
            'quiet:permission:feedback',
            `> ${excerpt(surface.feedback) || 'Enter feedback…'}`,
            'input',
          ),
        )
      return [...out, footer(sr)]
    }
    case 'recovery-request':
      out.push(
        row('quiet:recovery:heading', surface.heading, 'heading'),
        row('quiet:recovery:question', surface.question),
        row('quiet:recovery:display', excerpt(surface.display), 'muted'),
      )
      if (surface.feedbackMode)
        out.push(
          row(
            'quiet:recovery:feedback',
            `> ${excerpt(surface.feedback) || surface.feedbackPlaceholder}`,
            'input',
          ),
        )
      return [
        ...out,
        ...optionsRows(surface.options, 'quiet:recovery:option', density, sr),
        footer(sr),
      ]
    case 'permission-dashboard':
      out.push(
        row('quiet:dashboard:heading', surface.heading, 'heading'),
        row(
          'quiet:dashboard:tab',
          `Tab: ${surface.tabs.find((x) => x.current)?.label ?? 'Permissions'}`,
        ),
      )
      if (detailAllowed(density))
        out.push(
          row('quiet:dashboard:description', excerpt(surface.description)),
        )
      if (surface.query)
        out.push(
          row(
            'quiet:dashboard:search',
            `Search: ${excerpt(surface.query)}`,
            'input',
          ),
        )
      if (surface.originalWorkspace)
        out.push(
          row(
            'quiet:dashboard:workspace:original',
            `Original workspace: ${surface.originalWorkspace.label}`,
            'muted',
          ),
        )
      out.push(
        ...surface.rows
          .slice(0, 20)
          .map((item, i) =>
            row(
              `quiet:dashboard:${item.id ?? item.index ?? i}`,
              marker(
                item.selected,
                `${item.label}${item.status === 'retrying' ? ' (retrying)' : item.status === 'denied' ? ' (denied)' : ''}`,
                sr,
              ),
              item.selected
                ? 'selection'
                : item.status === 'denied'
                  ? 'error'
                  : item.status === 'retrying'
                    ? 'warning'
                    : 'body',
            ),
          ),
      )
      if (surface.rows.length === 0 && surface.emptyState)
        out.push(row('quiet:dashboard:empty', surface.emptyState, 'muted'))
      return [
        ...out,
        explicitFooter(
          'quiet:dashboard:footer',
          surface.rows.length > 0
            ? '↑/↓ select  Enter open  Esc close'
            : 'Esc close',
          surface.rows.length > 0
            ? 'Use left and right arrows to switch tabs. Use up and down arrows to select. Press Enter to open. Press Escape to close.'
            : 'Use left and right arrows to switch tabs. Press Escape to close.',
        ),
      ]
    case 'permission-rule-input':
    case 'workspace-directory-input':
      out.push(
        row(`quiet:${surface.kind}:heading`, surface.heading, 'heading'),
        row(`quiet:${surface.kind}:description`, excerpt(surface.description)),
        row(
          `quiet:${surface.kind}:value`,
          `> ${excerpt(surface.value) || surface.placeholder}`,
          'input',
        ),
      )
      return [
        ...out,
        explicitFooter(
          `quiet:${surface.kind}:footer`,
          'Enter confirm  Esc cancel',
          'Press Enter to confirm. Press Escape to cancel.',
        ),
      ]
    case 'permission-scope':
      out.push(
        row('quiet:scope:heading', surface.heading, 'heading'),
        row('quiet:scope:description', excerpt(surface.description)),
      )
      return [
        ...out,
        ...optionsRows(surface.options, 'quiet:scope:option', density, sr),
        footer(sr),
      ]
    case 'permission-delete':
      out.push(
        row('quiet:delete:heading', surface.heading, 'heading'),
        row('quiet:delete:rule', `${surface.rule} · ${surface.scope}`),
        row('quiet:delete:question', surface.question, 'warning'),
      )
      if (surface.description)
        out.push(
          row(
            'quiet:delete:description',
            excerpt(surface.description),
            'warning',
          ),
        )
      return [
        ...out,
        ...optionsRows(surface.options, 'quiet:delete:option', density, sr).map(
          (x, i) =>
            i === 0
              ? {
                  ...x,
                  segments: x.segments.map((s) => ({
                    ...s,
                    role: 'error' as const,
                  })),
                }
              : x,
        ),
        footer(sr),
      ]
    case 'workspace-directory-delete':
      out.push(
        row('quiet:workspace-delete:heading', surface.heading, 'heading'),
        row('quiet:workspace-delete:path', surface.path),
        row(
          'quiet:workspace-delete:description',
          excerpt(surface.description),
          'warning',
        ),
      )
      return [
        ...out,
        ...optionsRows(
          surface.options,
          'quiet:workspace-delete:option',
          density,
          sr,
        ),
        footer(sr),
      ]
    default:
      return unsupported(surface)
  }
}

function permissionLabel(
  item: TuiToolPermissionOption & {
    readonly index: number
    readonly selected: boolean
  },
): string {
  if (item.action === 'allow-once') return 'Allow once'
  if (item.action === 'deny') return 'Deny'
  const label = item.label.trim()
  if (/^yes,\s*/iu.test(label)) {
    const consequence = label.replace(/^yes,\s*/iu, '')
    return /^allow\b/iu.test(consequence)
      ? `Allow${consequence.slice('allow'.length)}`
      : `Allow ${consequence}`
  }
  if (/^no,\s*/iu.test(label)) return `Deny ${label.replace(/^no,\s*/iu, '')}`
  if (/^yes$/iu.test(label)) return 'Allow for this session'
  if (/^no$/iu.test(label)) return 'Deny'
  return label
}

function decision(
  surface: TuiDecisionSurfaceModel,
  density: QuietFrameDensity,
  sr: boolean,
): QuietFrameRow[] {
  const out: QuietFrameRow[] = [
    row(`quiet:decision:${surface.kind}:heading`, surface.heading, 'heading'),
  ]
  if (surface.kind === 'plan-approval') {
    if (detailAllowed(density)) {
      out.push(row('quiet:plan:explanation', surface.explanation))
      if (surface.plan)
        out.push(row('quiet:plan:content', excerpt(surface.plan, 160), 'muted'))
      out.push(
        row('quiet:plan:path', `Plan: ${excerpt(surface.planPath)}`, 'muted'),
      )
    }
    out.push(...optionsRows(surface.options, 'quiet:plan:option', density, sr))
    if (surface.feedbackMode)
      out.push(
        row(
          'quiet:plan:feedback',
          `> ${excerpt(surface.feedback) || surface.feedbackPlaceholder}`,
          'input',
        ),
      )
    return [
      ...out,
      explicitFooter(
        'quiet:plan:footer',
        '↑/↓ select  Enter confirm  Esc cancel',
        'Use up and down arrows to select. Press Enter to confirm. Press Escape to cancel.',
      ),
    ]
  }
  if (surface.progress)
    out.push(row('quiet:question:progress', surface.progress, 'muted'))
  if (surface.question) out.push(row('quiet:question:text', surface.question))
  out.push(
    ...optionsRows(surface.options, 'quiet:question:option', density, sr),
  )
  out.push(
    row(
      'quiet:question:answer',
      `Current answer: ${excerpt(surface.answer) || '(empty)'}`,
      'input',
    ),
  )
  if (surface.guidance)
    out.push(row('quiet:question:guidance', surface.guidance, 'muted'))
  if (surface.emptyState)
    out.push(row('quiet:question:empty', surface.emptyState, 'muted'))
  out.push(
    explicitFooter(
      'quiet:question:footer',
      'Enter answer  Esc cancel',
      'Press Enter to submit the answer. Press Escape to cancel.',
    ),
  )
  return out
}

function picker(
  surface:
    TuiSessionPickerModel | TuiCommandPaletteModel | TuiMentionPickerModel,
  density: QuietFrameDensity,
  sr: boolean,
): QuietFrameRow[] {
  const name =
    surface.kind === 'session-picker'
      ? 'Sessions'
      : surface.kind === 'command-palette'
        ? 'Commands'
        : 'Mentions'
  const out = [
    row(
      `quiet:${surface.kind}:heading`,
      `${name}${surface.query ? ` · ${excerpt(surface.query)}` : ''}`,
      'heading',
    ),
  ]
  const { start, end } = surface.visibleRange
  surface.rows.slice(start, end).forEach((item) => {
    const label =
      'path' in item
        ? item.path
        : 'invocation' in item
          ? detailAllowed(density)
            ? `${item.invocation} — ${item.description}`
            : item.invocation
          : 'name' in item
            ? detailAllowed(density)
              ? `${item.name} — ${item.description}`
              : item.name
            : detailAllowed(density) && item.detail
              ? `${item.label} — ${item.detail}`
              : item.label
    out.push(
      row(
        `quiet:${surface.kind}:${item.id}`,
        marker(item.selected, excerptOption(label, undefined, density), sr),
        item.selected ? 'selection' : 'body',
      ),
    )
  })
  if (surface.rows.length === 0)
    out.push(
      row(`quiet:${surface.kind}:empty`, 'No matching choices.', 'muted'),
    )
  return [
    ...out,
    explicitFooter(
      `quiet:${surface.kind}:footer`,
      '↑/↓ select  Enter confirm  Esc cancel',
      'Use up and down arrows to select. Press Enter to confirm. Press Escape to cancel.',
    ),
  ]
}

function elicitation(
  surface: TuiElicitationSurfaceModel,
  density: QuietFrameDensity,
  sr: boolean,
): QuietFrameRow[] {
  const out = [
    row(
      `quiet:elicitation:${surface.kind}:server`,
      `Server: ${excerpt(surface.serverName)}`,
      'heading',
    ),
    row(`quiet:elicitation:${surface.kind}:message`, excerpt(surface.message)),
  ]
  if (surface.kind === 'elicitation-url') {
    out.push(
      row('quiet:elicitation:url', `URL: ${excerpt(surface.url)}`),
      row(
        'quiet:elicitation:waiting',
        surface.waiting
          ? 'Waiting for confirmation…'
          : marker(surface.selection === 0, surface.actionLabel, sr),
        surface.waiting
          ? 'warning'
          : surface.selection === 0
            ? 'selection'
            : 'body',
      ),
      row(
        'quiet:elicitation:cancel',
        marker(surface.selection === 1, 'Cancel', sr),
        surface.selection === 1 ? 'selection' : 'body',
      ),
    )
    return [...out, footer(sr)]
  }
  const start = Math.max(
    0,
    Math.min(
      surface.state.focusIndex - 2,
      surface.state.fields.length - Math.max(1, surface.maxVisibleFields),
    ),
  )
  surface.state.fields
    .slice(start, start + Math.max(1, surface.maxVisibleFields))
    .forEach((field) => {
      const stored = surface.state.values[field.name]
      const value =
        surface.state.fields.indexOf(field) === surface.state.focusIndex &&
        ['text', 'number', 'integer'].includes(field.kind) &&
        surface.state.expandedField !== field.name
          ? surface.input
          : stored
      const text = `${field.title}${field.required ? ' (required)' : ''}: ${value === undefined || value === '' ? '(empty)' : String(value)}${detailAllowed(density) && field.description ? ` — ${excerpt(field.description)}` : ''}${surface.state.errors[field.name] ? ` — ${excerpt(surface.state.errors[field.name])}` : ''}`
      out.push(
        row(
          `quiet:elicitation:field:${field.name}`,
          marker(
            surface.state.fields.indexOf(field) === surface.state.focusIndex,
            text,
            sr,
          ),
          surface.state.fields.indexOf(field) === surface.state.focusIndex
            ? 'selection'
            : surface.state.errors[field.name]
              ? 'error'
              : 'body',
        ),
      )
      if (surface.state.expandedField === field.name) {
        const optionStart = Math.max(
          0,
          Math.min(surface.state.optionIndex - 10, field.options.length - 20),
        )
        field.options
          .slice(optionStart, optionStart + 20)
          .forEach((option, offset) => {
            const optionIndex = optionStart + offset
            const focused = surface.state.optionIndex === optionIndex
            const checked =
              field.kind === 'multi-enum' &&
              Array.isArray(stored) &&
              stored.includes(option.value)
            const label =
              field.kind === 'multi-enum'
                ? `${checked ? '[x]' : '[ ]'} ${option.label}`
                : option.label
            out.push(
              row(
                `quiet:elicitation:field:${field.name}:option:${option.value}`,
                marker(focused, label, sr),
                focused ? 'selection' : checked ? 'success' : 'body',
              ),
            )
          })
      }
    })
  return [
    ...out,
    explicitFooter(
      'quiet:elicitation:footer',
      '↑/↓ field  Enter edit/select  Esc cancel',
      'Use up and down arrows to change fields. Press Enter to edit or select. Press Escape to cancel.',
    ),
  ]
}

export function projectQuietChoiceRows(
  surface: QuietChoiceSurface,
  options: QuietChoiceProjectionOptions,
): readonly QuietFrameRow[] {
  const sr = options.screenReader === true
  if (surface.kind === 'permission')
    return permission(surface.surface, options.density, sr)
  if (surface.kind === 'elicitation')
    return elicitation(surface.surface, options.density, sr)
  if (surface.kind === 'editor-wait')
    return [
      row(
        'quiet:editor-wait',
        'Editor is open. Waiting for changes…',
        'warning',
      ),
      explicitFooter(
        'quiet:editor-wait:footer',
        'Esc cancel',
        'Press Escape to cancel.',
      ),
    ]
  if (surface.kind === 'exit-confirmation')
    return [
      row('quiet:exit:heading', 'Exit Praxis?', 'heading'),
      explicitFooter(
        'quiet:exit:footer',
        'Enter confirm  Esc cancel',
        'Press Enter to confirm. Press Escape to cancel.',
      ),
    ]
  if (surface.kind === 'plan-approval' || surface.kind === 'question')
    return decision(surface, options.density, sr)
  if (
    surface.kind === 'session-picker' ||
    surface.kind === 'command-palette' ||
    surface.kind === 'mention-picker'
  )
    return picker(surface, options.density, sr)
  return permission(surface, options.density, sr)
}
