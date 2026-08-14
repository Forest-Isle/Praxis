import { createContext, useContext, type ReactNode } from 'react'

import type { TuiCustomTheme } from './custom-themes.js'

export const TUI_THEMES = [
  'auto',
  'dark',
  'light',
  'dark-daltonized',
  'light-daltonized',
  'dark-ansi',
  'light-ansi',
] as const

export type TuiTheme = (typeof TUI_THEMES)[number]
export type TuiThemeSetting = TuiTheme | `custom:${string}`

export interface TuiThemeSettings {
  theme: TuiThemeSetting
  syntaxHighlightingDisabled: boolean
  customTheme?: TuiCustomTheme
}

export interface TuiSyntaxPalette {
  text: string
  keyword: string
  identifier: string
  string: string
  removedBackground?: string
  addedBackground?: string
  addedHighlight?: string
}

export interface TuiPalette {
  profile: TuiTheme
  dark: boolean
  ansiOnly: boolean
  syntaxHighlightingDisabled: boolean
  brand: string
  accent: string
  info: string
  link: string
  error: string
  success: string
  warning: string
  muted: string
  selectionText: string
  syntaxTheme: 'Monokai Extended' | 'GitHub' | 'ansi'
  syntax: TuiSyntaxPalette
}

export type TuiSyntaxToken = 'text' | 'keyword' | 'identifier' | 'string'
export type TerminalColorCapability = 'ansi16' | 'ansi256' | 'truecolor'

type TerminalEnvironment = Readonly<Record<string, string | undefined>>

export function tuiSyntaxStyle(
  palette: TuiPalette,
  token: TuiSyntaxToken,
  change?: 'added' | 'removed',
): { color?: string; backgroundColor?: string } {
  if (palette.syntaxHighlightingDisabled) return {}
  const backgroundColor =
    change === 'added'
      ? palette.syntax.addedBackground
      : change === 'removed'
        ? palette.syntax.removedBackground
        : undefined
  return {
    color: palette.syntax[token],
    ...(backgroundColor === undefined ? {} : { backgroundColor }),
  }
}

export const DEFAULT_TUI_THEME_SETTINGS: TuiThemeSettings = {
  theme: 'auto',
  syntaxHighlightingDisabled: false,
}

const DARK_SYNTAX: TuiSyntaxPalette = {
  text: '#ffffff',
  keyword: '#5fd7ff',
  identifier: '#afd700',
  string: '#d7d787',
  removedBackground: '#5f0000',
  addedBackground: '#005f00',
  addedHighlight: '#008700',
}

const LIGHT_SYNTAX: TuiSyntaxPalette = {
  text: '#303030',
  keyword: '#af005f',
  identifier: '#875faf',
  string: '#005f87',
  removedBackground: '#ffd7d7',
  addedBackground: '#d7ffd7',
  addedHighlight: '#afffaf',
}

function automaticDark(environment: TerminalEnvironment): boolean {
  const background = environment.COLORFGBG?.split(';').at(-1)
  return background === undefined || Number(background) < 8
}

export function terminalColorCapability(
  environment: TerminalEnvironment = process.env,
): TerminalColorCapability {
  if (environment.FORCE_COLOR === '3') return 'truecolor'
  if (environment.FORCE_COLOR === '2') return 'ansi256'
  if (environment.FORCE_COLOR === '1') return 'ansi16'
  if (/^(?:truecolor|24bit)$/iu.test(environment.COLORTERM ?? ''))
    return 'truecolor'
  if (/(?:direct|truecolor|24bit)/iu.test(environment.TERM ?? ''))
    return 'truecolor'
  if (
    /(?:iTerm\.app|WezTerm|ghostty|vscode|Hyper)/iu.test(
      environment.TERM_PROGRAM ?? '',
    )
  )
    return 'truecolor'
  return /256color/iu.test(environment.TERM ?? '') ? 'ansi256' : 'ansi16'
}

const ANSI_256_LEVELS = [0, 95, 135, 175, 215, 255] as const
const ansi256ColorCache = new Map<string, string>()
const ANSI_16_COLORS: Readonly<Record<string, string>> = {
  '#ffffff': 'whiteBright',
  '#5fd7ff': 'cyanBright',
  '#afd700': 'yellowBright',
  '#d7d787': 'whiteBright',
  '#5f0000': 'black',
  '#005f00': 'black',
  '#008700': 'green',
  '#d97757': 'redBright',
  '#b8a1ff': 'whiteBright',
  '#5fafff': 'cyanBright',
  '#ff5f5f': 'redBright',
  '#5fd75f': 'greenBright',
  '#ffd75f': 'yellowBright',
  '#a8a8a8': 'white',
  '#303030': 'black',
  '#af005f': 'red',
  '#875faf': 'magenta',
  '#005f87': 'blue',
  '#ffd7d7': 'whiteBright',
  '#d7ffd7': 'whiteBright',
  '#afffaf': 'whiteBright',
  '#005faf': 'blue',
  '#af0000': 'red',
  '#875f00': 'red',
  '#585858': 'black',
}

function ansi16Color(hex: string): string {
  return ANSI_16_COLORS[hex.toLowerCase()] ?? hex
}

function ansi256Color(hex: string): string {
  const cached = ansi256ColorCache.get(hex)
  if (cached) return cached
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex)
  if (!match) return hex
  const rgb: readonly [number, number, number] = [
    Number.parseInt(match[1] ?? '', 16),
    Number.parseInt(match[2] ?? '', 16),
    Number.parseInt(match[3] ?? '', 16),
  ]
  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (const [red, redLevel] of ANSI_256_LEVELS.entries()) {
    for (const [green, greenLevel] of ANSI_256_LEVELS.entries()) {
      for (const [blue, blueLevel] of ANSI_256_LEVELS.entries()) {
        const distance =
          (rgb[0] - redLevel) ** 2 +
          (rgb[1] - greenLevel) ** 2 +
          (rgb[2] - blueLevel) ** 2
        if (distance < bestDistance) {
          bestDistance = distance
          bestIndex = 16 + red * 36 + green * 6 + blue
        }
      }
    }
  }
  for (let index = 232; index <= 255; index += 1) {
    const level = 8 + (index - 232) * 10
    const distance = rgb.reduce(
      (total, component) => total + (component - level) ** 2,
      0,
    )
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = index
    }
  }
  const color = `ansi256(${bestIndex})`
  ansi256ColorCache.set(hex, color)
  return color
}

function adaptSyntaxColors(
  syntax: TuiSyntaxPalette,
  adapt: (color: string) => string,
): TuiSyntaxPalette {
  return {
    text: adapt(syntax.text),
    keyword: adapt(syntax.keyword),
    identifier: adapt(syntax.identifier),
    string: adapt(syntax.string),
    ...(syntax.removedBackground === undefined
      ? {}
      : { removedBackground: adapt(syntax.removedBackground) }),
    ...(syntax.addedBackground === undefined
      ? {}
      : { addedBackground: adapt(syntax.addedBackground) }),
    ...(syntax.addedHighlight === undefined
      ? {}
      : { addedHighlight: adapt(syntax.addedHighlight) }),
  }
}

export function tuiPalette(
  profile: TuiTheme,
  syntaxHighlightingDisabled = false,
  environment: TerminalEnvironment = process.env,
  customTheme?: TuiCustomTheme,
): TuiPalette {
  const dark =
    profile === 'auto'
      ? automaticDark(environment)
      : profile === 'dark' ||
        profile === 'dark-daltonized' ||
        profile === 'dark-ansi'
  const ansiOnly = profile.endsWith('-ansi')
  const daltonized = profile.endsWith('-daltonized')
  const syntaxBase: TuiSyntaxPalette = ansiOnly
    ? {
        text: dark ? 'white' : 'black',
        keyword: 'cyanBright',
        identifier: 'yellowBright',
        string: 'greenBright',
      }
    : dark
      ? {
          ...DARK_SYNTAX,
          ...(daltonized
            ? {
                addedBackground: '#00005f',
                addedHighlight: '#005f87',
              }
            : {}),
        }
      : {
          ...LIGHT_SYNTAX,
          ...(daltonized
            ? {
                addedBackground: '#d7ffff',
                addedHighlight: '#afd7ff',
              }
            : {}),
        }
  const terminalCapability = terminalColorCapability(environment)
  const adaptAutoColor =
    terminalCapability === 'ansi16'
      ? ansi16Color
      : terminalCapability === 'ansi256'
        ? ansi256Color
        : (color: string) => color
  const syntax =
    profile === 'auto'
      ? adaptSyntaxColors(syntaxBase, adaptAutoColor)
      : syntaxBase
  const autoColor = (color: string) =>
    profile === 'auto' ? adaptAutoColor(color) : color
  const palette: TuiPalette = {
    profile,
    dark,
    ansiOnly,
    syntaxHighlightingDisabled,
    brand: ansiOnly ? 'redBright' : autoColor('#D97757'),
    accent: ansiOnly
      ? 'magentaBright'
      : daltonized
        ? dark
          ? '#5fd7ff'
          : '#005f87'
        : dark
          ? autoColor('#B8A1FF')
          : autoColor('#875faf'),
    info: ansiOnly ? 'cyanBright' : autoColor(dark ? '#5fd7ff' : '#005f87'),
    link: ansiOnly ? 'blueBright' : autoColor(dark ? '#5fafff' : '#005faf'),
    error: ansiOnly ? 'redBright' : autoColor(dark ? '#ff5f5f' : '#af0000'),
    success: ansiOnly ? 'greenBright' : autoColor(dark ? '#5fd75f' : '#008700'),
    warning: ansiOnly
      ? 'yellowBright'
      : autoColor(dark ? '#ffd75f' : '#875f00'),
    muted: ansiOnly
      ? dark
        ? 'white'
        : 'black'
      : autoColor(dark ? '#a8a8a8' : '#585858'),
    selectionText: dark ? 'black' : 'white',
    syntaxTheme: ansiOnly ? 'ansi' : dark ? 'Monokai Extended' : 'GitHub',
    syntax,
  }
  if (customTheme) {
    const overrides = customTheme.overrides
    const override = (token: keyof typeof overrides, fallback: string) =>
      overrides[token] ?? fallback
    palette.brand = override('claude', palette.brand)
    palette.accent = override('suggestion', palette.accent)
    palette.info = override('professionalBlue', palette.info)
    palette.link = override('ide', palette.link)
    palette.error = override('error', palette.error)
    palette.success = override('success', palette.success)
    palette.warning = override('warning', palette.warning)
    palette.muted = override('inactive', palette.muted)
    palette.selectionText = override('inverseText', palette.selectionText)
    palette.syntax = {
      ...palette.syntax,
      text: override('text', palette.syntax.text),
      keyword: override(
        'claudeBlue_FOR_SYSTEM_SPINNER',
        palette.syntax.keyword,
      ),
      identifier: override('suggestion', palette.syntax.identifier),
      string: override('success', palette.syntax.string),
      removedBackground: override(
        'diffRemoved',
        palette.syntax.removedBackground ?? '',
      ),
      addedBackground: override(
        'diffAdded',
        palette.syntax.addedBackground ?? '',
      ),
      addedHighlight: override(
        'diffAddedWord',
        palette.syntax.addedHighlight ?? '',
      ),
    }
    palette.profile = customTheme.base
  }
  return palette
}

const TuiPaletteContext = createContext<TuiPalette>(tuiPalette('auto'))

export function TuiThemeProvider({
  settings,
  children,
}: {
  settings: TuiThemeSettings
  children: ReactNode
}) {
  const baseTheme = TUI_THEMES.includes(settings.theme as TuiTheme)
    ? (settings.theme as TuiTheme)
    : 'dark'
  return (
    <TuiPaletteContext.Provider
      value={tuiPalette(
        baseTheme,
        settings.syntaxHighlightingDisabled,
        process.env,
        settings.customTheme,
      )}
    >
      {children}
    </TuiPaletteContext.Provider>
  )
}

export function useTuiPalette(): TuiPalette {
  return useContext(TuiPaletteContext)
}
