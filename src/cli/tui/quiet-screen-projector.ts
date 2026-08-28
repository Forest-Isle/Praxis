import {
  projectQuietChoiceRows,
  type QuietChoiceSurface,
  type QuietOverlaySurface,
  type QuietPrioritySurface,
} from './quiet-choice-rows.js'
import {
  projectQuietOperationalRows,
  type QuietOperationalSurface,
} from './quiet-operational-rows.js'
import {
  projectQuietSettingsRows,
  type QuietSettingsSurface,
} from './quiet-settings-rows.js'
import {
  projectQuietFrame,
  createQuietFrameRow,
  resolveQuietFrameDensity,
  type QuietFrame,
  type QuietFrameInput,
} from './quiet-frame.js'
import type {
  TuiScreenModel,
  TuiScreenSurfaceModels,
} from './tui-screen-model.js'
import type { TuiPermissionSurfaceModel } from './permission-surface-model.js'
import type { TuiSessionPickerModel } from './session-picker-model.js'

export type QuietSecondarySurface =
  TuiPermissionSurfaceModel | QuietOperationalSurface | QuietSettingsSurface

export interface QuietScreenSurfaces extends TuiScreenSurfaceModels {
  readonly sessionPicker: TuiSessionPickerModel
  readonly priority: QuietPrioritySurface
  readonly secondary: QuietSecondarySurface
  readonly overlay: QuietOverlaySurface
}

export interface QuietScreenProjectionInput {
  readonly screen: TuiScreenModel<QuietScreenSurfaces>
  readonly composerText: string
  readonly composerCursor: number
  readonly shellMode: boolean
  readonly busy: boolean
  readonly status: string
  readonly display?: QuietFrameInput['display']
}

function unsupported(value: never): never {
  throw new Error(`Unsupported quiet secondary surface: ${String(value)}`)
}

function maxItems(rows: number | undefined): number {
  if (rows === undefined || !Number.isFinite(rows) || rows <= 0) return 20
  return Math.max(1, Math.floor(rows) - 6)
}

function overlay(
  surface: readonly QuietOverlaySurface[],
): QuietChoiceSurface | undefined {
  return (
    surface.find((item) => item.kind === 'exit-confirmation') ??
    surface.find((item) => item.kind === 'mention-picker') ??
    surface.find((item) => item.kind === 'command-palette')
  )
}

function projectFocusRows(
  input: QuietScreenProjectionInput,
  density: ReturnType<typeof resolveQuietFrameDensity>,
  screenReader: boolean,
): QuietFrameInput['focusRows'] {
  const body = input.screen.body
  const options = { density, screenReader }
  if (body.kind === 'session-picker')
    return projectQuietChoiceRows(body.surface, options)
  const foreground = body.foreground
  if (foreground.kind === 'priority')
    return projectQuietChoiceRows(foreground.surface, options)
  if (foreground.kind === 'secondary') {
    const surface = foreground.surface
    switch (surface.kind) {
      case 'tool-request':
      case 'recovery-request':
      case 'permission-dashboard':
      case 'permission-rule-input':
      case 'permission-scope':
      case 'permission-delete':
      case 'workspace-directory-input':
      case 'workspace-directory-delete':
        return projectQuietChoiceRows(surface, options)
      case 'help':
      case 'diff':
      case 'mcp-panel':
      case 'tasks-panel':
      case 'list-panel':
      case 'btw-panel':
      case 'rewind-panel':
        return projectQuietOperationalRows(surface, {
          ...options,
          maxItems: maxItems(input.screen.presentation.viewport.rows),
        })
      case 'doctor-panel':
      case 'memory-panel':
      case 'hooks-panel':
      case 'config-panel':
      case 'sandbox-panel':
      case 'model-panel':
      case 'effort-panel':
      case 'theme-panel':
      case 'custom-theme-create':
      case 'custom-theme-editor':
      case 'custom-theme-token':
      case 'custom-theme-delete':
      case 'model-input':
      case 'export':
      case 'copy':
      case 'export-filename':
      case 'compact-progress':
        return projectQuietSettingsRows(surface, {
          ...options,
          maxItems: maxItems(input.screen.presentation.viewport.rows),
        })
      default:
        return unsupported(surface)
    }
  }
  const selected = overlay(foreground.overlays)
  return selected === undefined ? [] : projectQuietChoiceRows(selected, options)
}

export function projectQuietScreenFrame(
  input: QuietScreenProjectionInput,
): QuietFrame {
  const viewport = input.screen.presentation.viewport
  const width =
    Number.isFinite(viewport.columns) && viewport.columns > 0
      ? Math.floor(viewport.columns)
      : 1
  const rows =
    viewport.rows === undefined ||
    !Number.isFinite(viewport.rows) ||
    viewport.rows <= 0
      ? undefined
      : Math.floor(viewport.rows)
  const density = resolveQuietFrameDensity(width)
  let focusRows: QuietFrameInput['focusRows']
  try {
    focusRows = projectFocusRows(
      input,
      density,
      input.screen.presentation.screenReader,
    )
  } catch {
    focusRows = [
      createQuietFrameRow(
        'quiet:projection-error',
        'Unable to render this view. Press Esc to return.',
        'focus',
        'error',
        'Unable to render this view. Press Esc to return.',
      ),
    ]
  }
  return projectQuietFrame({
    screen: input.screen,
    width,
    rows,
    composerText: input.composerText,
    composerCursor: input.composerCursor,
    shellMode: input.shellMode,
    busy: input.busy,
    status: input.status,
    ...(input.display === undefined ? {} : { display: input.display }),
    focusRows,
  })
}
