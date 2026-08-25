import {
  CUSTOM_THEME_TOKENS,
  type CustomThemeBase,
  type CustomThemeToken,
  type TuiCustomTheme,
} from './custom-themes.js'
import { TUI_THEMES, type TuiTheme, type TuiThemeSetting } from './theme.js'

export interface TuiThemePanelOption {
  readonly id: TuiTheme | `custom:${string}` | '__new__'
  readonly label: string
  readonly current: boolean
  readonly customTheme?: TuiCustomTheme
}

export type TuiThemeSurfaceModel =
  | {
      readonly kind: 'theme-panel'
      readonly currentTheme: TuiThemeSetting
      readonly options: readonly TuiThemePanelOption[]
      readonly selectedIndex: number
      readonly syntaxHighlightingDisabled: boolean
    }
  | {
      readonly kind: 'custom-theme-create'
      readonly base: CustomThemeBase
      readonly name: string
    }
  | {
      readonly kind: 'custom-theme-editor'
      readonly theme: TuiCustomTheme
      readonly tokens: readonly CustomThemeToken[]
      readonly selectedIndex: number
      readonly query: string
    }
  | {
      readonly kind: 'custom-theme-token'
      readonly theme: TuiCustomTheme
      readonly token: CustomThemeToken
      readonly value: string
    }
  | {
      readonly kind: 'custom-theme-delete'
      readonly theme: TuiCustomTheme
      readonly selectedIndex: number
    }

export type TuiThemeSurfaceInput =
  | {
      readonly kind: 'theme'
      readonly currentTheme: TuiThemeSetting
      readonly customThemes: readonly TuiCustomTheme[]
      readonly selectedIndex: number
      readonly syntaxHighlightingDisabled: boolean
    }
  | {
      readonly kind: 'custom-theme-create'
      readonly base: CustomThemeBase
      readonly name: string
    }
  | {
      readonly kind: 'custom-theme-editor'
      readonly theme: TuiCustomTheme
      readonly selectedIndex: number
      readonly query: string
    }
  | {
      readonly kind: 'custom-theme-token'
      readonly theme: TuiCustomTheme
      readonly token: CustomThemeToken
      readonly value: string
    }
  | {
      readonly kind: 'custom-theme-delete'
      readonly theme: TuiCustomTheme
      readonly selectedIndex: number
    }

export function projectTuiThemeSurface(
  input: Extract<TuiThemeSurfaceInput, { kind: 'theme' }>,
): Extract<TuiThemeSurfaceModel, { kind: 'theme-panel' }>
export function projectTuiThemeSurface(
  input: Extract<TuiThemeSurfaceInput, { kind: 'custom-theme-editor' }>,
): Extract<TuiThemeSurfaceModel, { kind: 'custom-theme-editor' }>
export function projectTuiThemeSurface(
  input: Extract<TuiThemeSurfaceInput, { kind: 'custom-theme-create' }>,
): Extract<TuiThemeSurfaceModel, { kind: 'custom-theme-create' }>
export function projectTuiThemeSurface(
  input: Extract<TuiThemeSurfaceInput, { kind: 'custom-theme-token' }>,
): Extract<TuiThemeSurfaceModel, { kind: 'custom-theme-token' }>
export function projectTuiThemeSurface(
  input: Extract<TuiThemeSurfaceInput, { kind: 'custom-theme-delete' }>,
): Extract<TuiThemeSurfaceModel, { kind: 'custom-theme-delete' }>
export function projectTuiThemeSurface(
  input: TuiThemeSurfaceInput,
): TuiThemeSurfaceModel {
  if (input.kind === 'theme') {
    const options: TuiThemePanelOption[] = [
      ...TUI_THEMES.map((id) => ({
        id,
        label:
          id === 'auto'
            ? 'Auto (match terminal)'
            : id === 'dark'
              ? 'Dark mode'
              : id === 'light'
                ? 'Light mode'
                : id === 'dark-daltonized'
                  ? 'Dark mode (colorblind-friendly)'
                  : id === 'light-daltonized'
                    ? 'Light mode (colorblind-friendly)'
                    : id === 'dark-ansi'
                      ? 'Dark mode (ANSI colors only)'
                      : 'Light mode (ANSI colors only)',
        current: id === input.currentTheme,
      })),
      ...input.customThemes.map((theme) => ({
        id: `custom:${theme.slug}` as const,
        label: `${theme.name} (custom)`,
        current: `custom:${theme.slug}` === input.currentTheme,
        customTheme: theme,
      })),
      { id: '__new__' as const, label: 'New custom theme…', current: false },
    ]
    return {
      kind: 'theme-panel',
      currentTheme: input.currentTheme,
      options,
      selectedIndex: Math.max(
        0,
        Math.min(options.length - 1, input.selectedIndex),
      ),
      syntaxHighlightingDisabled: input.syntaxHighlightingDisabled,
    }
  }
  if (input.kind === 'custom-theme-editor') {
    const query = input.query
    const tokens = CUSTOM_THEME_TOKENS.filter((token) =>
      token.toLowerCase().includes(query.toLowerCase()),
    )
    return {
      kind: 'custom-theme-editor',
      theme: input.theme,
      tokens,
      selectedIndex: Math.max(
        0,
        Math.min(Math.max(0, tokens.length - 1), input.selectedIndex),
      ),
      query,
    }
  }
  return input
}
