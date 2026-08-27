import { createContext, useContext, useMemo, type ReactNode } from 'react'

import type { TuiCustomTheme } from './custom-themes.js'
import type { AgentColorName } from '../../core/agent-color.js'
export type { AgentColorName } from '../../core/agent-color.js'

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
  sessionColors: Readonly<Record<AgentColorName, string>>
  syntaxTheme: 'Monokai Extended' | 'GitHub' | 'ansi'
  syntax: TuiSyntaxPalette
}

/** Ink-compatible text attributes owned by the Praxis semantic theme. */
export interface TuiTextStyle {
  readonly color?: string
  readonly backgroundColor?: string
  readonly bold?: boolean
  readonly dimColor?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly inverse?: boolean
}

/** Ink-compatible surface attributes owned by the Praxis semantic theme. */
export interface TuiSurfaceStyle {
  readonly borderColor?: string
  readonly backgroundColor?: string
}

export const TUI_TEXT_ROLES = [
  'body',
  'productIdentity',
  'heading',
  'navigation',
  'selectedRow',
  'selectedTab',
  'focusMarker',
  'inputMarker',
  'inputCursor',
  'muted',
  'link',
  'active',
  'info',
  'success',
  'warning',
  'permission',
  'error',
  'diffAdded',
  'diffRemoved',
  'shellMode',
] as const

export type TuiTextRole = (typeof TUI_TEXT_ROLES)[number]

export const TUI_SURFACE_ROLES = [
  'neutralBorder',
  'separator',
  'selectedRow',
  'selectedTab',
  'input',
  'decision',
  'error',
] as const

export type TuiSurfaceRole = (typeof TUI_SURFACE_ROLES)[number]

export interface TuiSemanticTheme {
  readonly profile: TuiTheme
  readonly dark: boolean
  readonly ansiOnly: boolean
  readonly terminalColorCapability: TerminalColorCapability
  readonly syntaxHighlightingDisabled: boolean
  readonly screenReader: boolean
  readonly noColor: boolean
  readonly syntaxTheme: TuiPalette['syntaxTheme']
  readonly text: Readonly<Record<TuiTextRole, TuiTextStyle>>
  readonly surface: Readonly<Record<TuiSurfaceRole, TuiSurfaceStyle>>
  syntax(
    token: TuiSyntaxToken,
    change?: 'added' | 'removed',
  ): Readonly<{ color?: string; backgroundColor?: string }>
  session(agentColor: AgentColorName): string | undefined
}

export interface TuiThemePresentationOptions {
  environment?: TerminalEnvironment
  screenReader?: boolean
}

export type TuiSyntaxToken =
  'text' | 'keyword' | 'identifier' | 'string' | 'addedHighlight'
export type TerminalColorCapability = 'ansi16' | 'ansi256' | 'truecolor'

type TerminalEnvironment = Readonly<Record<string, string | undefined>>

export function tuiSyntaxStyle(
  palette: TuiPalette | TuiSemanticTheme,
  token: TuiSyntaxToken,
  change?: 'added' | 'removed',
): { color?: string; backgroundColor?: string } {
  if (typeof palette.syntax === 'function') return palette.syntax(token, change)
  if (palette.syntaxHighlightingDisabled) return {}
  const syntax = palette.syntax as TuiSyntaxPalette
  if (token === 'addedHighlight') {
    return syntax.addedHighlight === undefined
      ? {}
      : { backgroundColor: syntax.addedHighlight }
  }
  const backgroundColor =
    change === 'added'
      ? syntax.addedBackground
      : change === 'removed'
        ? syntax.removedBackground
        : undefined
  return {
    color: syntax[token],
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

const NORMAL_SESSION_COLORS: Readonly<Record<AgentColorName, string>> = {
  red: '#dc2626',
  blue: '#2563eb',
  green: '#16a34a',
  yellow: '#ca8a04',
  purple: '#9333ea',
  orange: '#ea580c',
  pink: '#db2777',
  cyan: '#0891b2',
}

const LIGHT_ANSI_SESSION_COLORS: Readonly<Record<AgentColorName, string>> = {
  red: 'red',
  blue: 'blue',
  green: 'green',
  yellow: 'yellow',
  purple: 'magenta',
  orange: 'redBright',
  pink: 'magentaBright',
  cyan: 'cyan',
}

const DARK_ANSI_SESSION_COLORS: Readonly<Record<AgentColorName, string>> = {
  red: 'redBright',
  blue: 'blueBright',
  green: 'greenBright',
  yellow: 'yellowBright',
  purple: 'magentaBright',
  orange: 'redBright',
  pink: 'magentaBright',
  cyan: 'cyanBright',
}

const LIGHT_DALTONIZED_SESSION_COLORS: Readonly<
  Record<AgentColorName, string>
> = {
  red: '#cc0000',
  blue: '#0066cc',
  green: '#00cc00',
  yellow: '#ffcc00',
  purple: '#800080',
  orange: '#ff8000',
  pink: '#ff66b2',
  cyan: '#00b2b2',
}

const DARK_DALTONIZED_SESSION_COLORS: Readonly<Record<AgentColorName, string>> =
  {
    red: '#ff6666',
    blue: '#66b2ff',
    green: '#66ff66',
    yellow: '#ffff66',
    purple: '#b266ff',
    orange: '#ffb266',
    pink: '#ff99cc',
    cyan: '#66cccc',
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
const ANSI_16_RGB = [
  [0, 0, 0],
  [128, 0, 0],
  [0, 128, 0],
  [128, 128, 0],
  [0, 0, 128],
  [128, 0, 128],
  [0, 128, 128],
  [192, 192, 192],
  [128, 128, 128],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [0, 0, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
] as const
const ANSI_16_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'blackBright',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright',
] as const
const ansi256ColorCache = new Map<string, string>()
const ANSI_16_COLORS: Readonly<Record<string, string>> = {
  '#ffffff': 'whiteBright',
  '#5fd7ff': 'cyanBright',
  '#afd700': 'yellowBright',
  '#d7d787': 'whiteBright',
  '#5f0000': 'black',
  '#005f00': 'black',
  '#008700': 'green',
  '#16a34a': 'green',
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

function ansi16Color(value: string): string {
  const normalized = normalizeAnsiName(value)
  const directAnsi = /^ansi256\((\d+)\)$/iu.exec(normalized)
  if (directAnsi) {
    const index = Number(directAnsi[1])
    if (index >= 0 && index < ANSI_16_NAMES.length)
      return ANSI_16_NAMES[index] ?? 'black'
  }
  const known = ANSI_16_COLORS[normalized.toLowerCase()]
  if (known) return known
  const hex = hexFromRgb(normalized) ?? ansi256ToHex(normalized)
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(
    hex ?? normalized,
  )
  if (!match) return normalized
  const rgb = [
    Number.parseInt(match[1] ?? '0', 16),
    Number.parseInt(match[2] ?? '0', 16),
    Number.parseInt(match[3] ?? '0', 16),
  ]
  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (const [index, candidate] of ANSI_16_RGB.entries()) {
    const distance = candidate.reduce(
      (total: number, component, componentIndex) =>
        total + ((rgb[componentIndex] ?? 0) - component) ** 2,
      0,
    )
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = index
    }
  }
  return ANSI_16_NAMES[bestIndex] ?? 'black'
}

function hexFromRgb(value: string): string | undefined {
  const match = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/iu.exec(value)
  if (!match) return undefined
  return `#${[match[1], match[2], match[3]]
    .map((component) => Number(component).toString(16).padStart(2, '0'))
    .join('')}`
}

function ansi256ToHex(value: string): string | undefined {
  const match = /^ansi256\((\d+)\)$/iu.exec(value)
  if (!match) return undefined
  const index = Number(match[1])
  if (index < 0 || index > 255) return undefined
  if (index < 16) {
    const [red, green, blue] = ANSI_16_RGB[index] ?? []
    if (red === undefined || green === undefined || blue === undefined)
      return undefined
    return `#${[red, green, blue]
      .map((component) => component.toString(16).padStart(2, '0'))
      .join('')}`
  }
  if (index >= 232) {
    const level = 8 + (index - 232) * 10
    return `#${[level, level, level]
      .map((component) => component.toString(16).padStart(2, '0'))
      .join('')}`
  }
  const offset = index - 16
  const red = Math.floor(offset / 36)
  const green = Math.floor((offset % 36) / 6)
  const blue = offset % 6
  const levels = [0, 95, 135, 175, 215, 255]
  return `#${[levels[red], levels[green], levels[blue]]
    .map((component) => (component ?? 0).toString(16).padStart(2, '0'))
    .join('')}`
}

function normalizeAnsiName(value: string): string {
  return value.startsWith('ansi:') ? value.slice('ansi:'.length) : value
}

function adaptEffectiveColor(
  value: string,
  capability: TerminalColorCapability,
): string {
  const normalized = normalizeAnsiName(value)
  if (capability === 'truecolor') return normalized
  if (
    capability === 'ansi256' &&
    /^ansi256\((?:\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\)$/u.test(normalized)
  )
    return normalized
  const rgb = hexFromRgb(normalized)
  const hex = rgb ?? ansi256ToHex(normalized) ?? normalized
  if (capability === 'ansi16') {
    if (!hex.startsWith('#')) return hex
    return ansi16Color(hex)
  }
  if (hex.startsWith('#')) return ansi256Color(hex)
  return hex
}

function projectPalette(
  palette: TuiPalette,
  capability: TerminalColorCapability,
): TuiPalette {
  const adapt = (value: string) => adaptEffectiveColor(value, capability)
  return {
    ...palette,
    brand: adapt(palette.brand),
    accent: adapt(palette.accent),
    info: adapt(palette.info),
    link: adapt(palette.link),
    error: adapt(palette.error),
    success: adapt(palette.success),
    warning: adapt(palette.warning),
    muted: adapt(palette.muted),
    selectionText: adapt(palette.selectionText),
    sessionColors: Object.fromEntries(
      Object.entries(palette.sessionColors).map(([name, value]) => [
        name,
        adapt(value),
      ]),
    ) as Readonly<Record<AgentColorName, string>>,
    syntax: adaptSyntaxColors(palette.syntax, adapt),
  }
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

function resolveRawPalette(
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
  const sessionColors = ansiOnly
    ? dark
      ? DARK_ANSI_SESSION_COLORS
      : LIGHT_ANSI_SESSION_COLORS
    : daltonized
      ? dark
        ? DARK_DALTONIZED_SESSION_COLORS
        : LIGHT_DALTONIZED_SESSION_COLORS
      : {
          red: NORMAL_SESSION_COLORS.red,
          blue: NORMAL_SESSION_COLORS.blue,
          green: NORMAL_SESSION_COLORS.green,
          yellow: NORMAL_SESSION_COLORS.yellow,
          purple: NORMAL_SESSION_COLORS.purple,
          orange: NORMAL_SESSION_COLORS.orange,
          pink: NORMAL_SESSION_COLORS.pink,
          cyan: NORMAL_SESSION_COLORS.cyan,
        }
  const palette: TuiPalette = {
    profile,
    dark,
    ansiOnly,
    syntaxHighlightingDisabled,
    sessionColors,
    brand: ansiOnly ? 'redBright' : '#D97757',
    accent: ansiOnly ? 'redBright' : '#D97757',
    info: ansiOnly ? 'cyanBright' : dark ? '#5fd7ff' : '#005f87',
    link: ansiOnly ? 'blueBright' : dark ? '#5fafff' : '#005faf',
    error: ansiOnly ? 'redBright' : dark ? '#ff5f5f' : '#af0000',
    success: ansiOnly ? 'greenBright' : dark ? '#5fd75f' : '#008700',
    warning: ansiOnly ? 'yellowBright' : dark ? '#ffd75f' : '#875f00',
    muted: ansiOnly ? (dark ? 'white' : 'black') : dark ? '#a8a8a8' : '#585858',
    selectionText: dark ? 'black' : 'white',
    syntaxTheme: ansiOnly ? 'ansi' : dark ? 'Monokai Extended' : 'GitHub',
    syntax: syntaxBase,
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
      ...(palette.syntax.removedBackground !== undefined ||
      overrides.diffRemoved !== undefined
        ? {
            removedBackground: override(
              'diffRemoved',
              palette.syntax.removedBackground ?? '',
            ),
          }
        : {}),
      ...(palette.syntax.addedBackground !== undefined ||
      overrides.diffAdded !== undefined
        ? {
            addedBackground: override(
              'diffAdded',
              palette.syntax.addedBackground ?? '',
            ),
          }
        : {}),
      ...(palette.syntax.addedHighlight !== undefined ||
      overrides.diffAddedWord !== undefined
        ? {
            addedHighlight: override(
              'diffAddedWord',
              palette.syntax.addedHighlight ?? '',
            ),
          }
        : {}),
    }
    palette.profile = customTheme.base
  }
  return palette
}

export function tuiPalette(
  profile: TuiTheme,
  syntaxHighlightingDisabled = false,
  environment: TerminalEnvironment = process.env,
  customTheme?: TuiCustomTheme,
): TuiPalette {
  return resolvedThemeBundle(
    {
      theme: profile,
      syntaxHighlightingDisabled,
      ...(customTheme === undefined ? {} : { customTheme }),
    },
    { environment },
  ).palette
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value)
}

function semanticText(
  color: string | undefined,
  options: TuiThemePresentationOptions,
  attributes: Omit<TuiTextStyle, 'color'> = {},
): TuiTextStyle {
  const withoutBackground = { ...attributes }
  delete withoutBackground.backgroundColor
  if (
    color === undefined ||
    options.screenReader ||
    options.environment?.NO_COLOR !== undefined
  )
    return frozen(withoutBackground)
  return frozen({ color, ...attributes })
}

function semanticSurface(
  colors: TuiSurfaceStyle,
  options: TuiThemePresentationOptions,
): TuiSurfaceStyle {
  if (options.screenReader || options.environment?.NO_COLOR !== undefined)
    return frozen({})
  return frozen(colors)
}

interface SemanticDiffColors {
  readonly added: string
  readonly removed: string
}

const EMPTY_STYLE: Readonly<{
  color?: string
  backgroundColor?: string
}> = Object.freeze({})

function buildSemanticTheme(
  settings: TuiThemeSettings,
  palette: TuiPalette,
  options: TuiThemePresentationOptions = {},
  capability: TerminalColorCapability = palette.ansiOnly
    ? 'ansi16'
    : terminalColorCapability(options.environment ?? process.env),
  diffColors: SemanticDiffColors = {
    added: palette.success,
    removed: palette.error,
  },
): TuiSemanticTheme {
  const environment = options.environment ?? process.env
  const noColor = environment.NO_COLOR !== undefined
  const screenReader = options.screenReader === true
  const suppressColor = noColor || screenReader
  const productColor = palette.brand
  const focusColor = palette.accent
  const infoColor = palette.info
  const linkColor = palette.link
  const errorColor = palette.error
  const successColor = palette.success
  const warningColor = palette.warning
  const mutedColor = palette.muted
  const selectionTextColor = palette.selectionText
  const syntaxPalette = palette.syntax
  const sessionColors = palette.sessionColors
  const color = (value: string): string | undefined =>
    suppressColor ? undefined : value
  const diffAdded = diffColors.added
  const diffRemoved = diffColors.removed
  const text = {
    body: semanticText(undefined, options),
    productIdentity: semanticText(color(productColor), options, {
      bold: true,
    }),
    heading: semanticText(undefined, options, { bold: true }),
    navigation: semanticText(color(focusColor), options, { bold: true }),
    selectedRow: semanticText(color(selectionTextColor), options, {
      ...(suppressColor ? {} : { backgroundColor: focusColor }),
      bold: true,
    }),
    selectedTab: semanticText(color(selectionTextColor), options, {
      ...(suppressColor ? {} : { backgroundColor: focusColor }),
      bold: true,
    }),
    focusMarker: semanticText(color(focusColor), options, { bold: true }),
    inputMarker: semanticText(color(focusColor), options),
    inputCursor: frozen(suppressColor ? {} : { inverse: true }),
    muted: semanticText(color(mutedColor), options, { dimColor: true }),
    link: semanticText(color(linkColor), options, { underline: true }),
    active: semanticText(color(infoColor), options, { bold: true }),
    info: semanticText(color(infoColor), options),
    success: semanticText(color(successColor), options),
    warning: semanticText(color(warningColor), options),
    permission: semanticText(color(warningColor), options, { bold: true }),
    error: semanticText(color(errorColor), options, { bold: true }),
    diffAdded: semanticText(color(diffAdded), options),
    diffRemoved: semanticText(color(diffRemoved), options),
    shellMode: semanticText(color(infoColor), options, { bold: true }),
  } satisfies Record<TuiTextRole, TuiTextStyle>
  const border = (value: string): TuiSurfaceStyle => {
    const resolved = color(value)
    return resolved === undefined ? {} : { borderColor: resolved }
  }
  const background = (value: string): TuiSurfaceStyle => {
    const resolved = color(value)
    return resolved === undefined ? {} : { backgroundColor: resolved }
  }
  const surface = {
    neutralBorder: semanticSurface(border(mutedColor), options),
    separator: semanticSurface(border(mutedColor), options),
    selectedRow: semanticSurface(background(focusColor), options),
    selectedTab: semanticSurface(background(focusColor), options),
    input: semanticSurface(border(focusColor), options),
    decision: semanticSurface(border(warningColor), options),
    error: semanticSurface(border(errorColor), options),
  } satisfies Record<TuiSurfaceRole, TuiSurfaceStyle>
  const syntaxStyle = (token: TuiSyntaxToken, change?: 'added' | 'removed') => {
    if (settings.syntaxHighlightingDisabled || suppressColor) return EMPTY_STYLE
    const backgroundColor =
      change === 'added'
        ? syntaxPalette.addedBackground
        : change === 'removed'
          ? syntaxPalette.removedBackground
          : token === 'addedHighlight'
            ? syntaxPalette.addedHighlight
            : undefined
    if (token === 'addedHighlight')
      return backgroundColor === undefined
        ? frozen({})
        : frozen({ backgroundColor })
    return frozen({
      color: syntaxPalette[token],
      ...(backgroundColor === undefined ? {} : { backgroundColor }),
    })
  }
  const syntaxStyles = new Map<
    string,
    Readonly<{ color?: string; backgroundColor?: string }>
  >()
  for (const token of [
    'text',
    'keyword',
    'identifier',
    'string',
    'addedHighlight',
  ] as const) {
    for (const change of [undefined, 'added', 'removed'] as const) {
      syntaxStyles.set(
        change === undefined ? token : `${token}:${change}`,
        syntaxStyle(token, change),
      )
    }
  }
  return {
    profile: palette.profile,
    dark: palette.dark,
    ansiOnly: palette.ansiOnly,
    terminalColorCapability: capability,
    syntaxHighlightingDisabled: settings.syntaxHighlightingDisabled,
    screenReader,
    noColor,
    syntaxTheme: palette.syntaxTheme,
    text: frozen(text),
    surface: frozen(surface),
    syntax: (token, change) =>
      syntaxStyles.get(change === undefined ? token : `${token}:${change}`) ??
      EMPTY_STYLE,
    session: (agentColor: AgentColorName) =>
      suppressColor ? undefined : sessionColors[agentColor],
  }
}

interface ResolvedThemeBundle {
  readonly palette: TuiPalette
  readonly theme: TuiSemanticTheme
}

function resolvedThemeBundle(
  settings: TuiThemeSettings,
  options: TuiThemePresentationOptions = {},
): ResolvedThemeBundle {
  const profile = TUI_THEMES.includes(settings.theme as TuiTheme)
    ? (settings.theme as TuiTheme)
    : (settings.customTheme?.base ?? 'dark')
  const environment = options.environment ?? process.env
  const capability = profile.endsWith('-ansi')
    ? 'ansi16'
    : terminalColorCapability(environment)
  const rawPalette = resolveRawPalette(
    profile,
    settings.syntaxHighlightingDisabled,
    environment,
    settings.customTheme,
  )
  const palette = projectPalette(rawPalette, capability)
  const adapt = (value: string) => adaptEffectiveColor(value, capability)
  return {
    palette,
    theme: buildSemanticTheme(settings, palette, options, capability, {
      added: adapt(
        settings.customTheme?.overrides.diffAdded ?? rawPalette.success,
      ),
      removed: adapt(
        settings.customTheme?.overrides.diffRemoved ?? rawPalette.error,
      ),
    }),
  }
}

export function resolveTuiTheme(
  settings: TuiThemeSettings,
  options: TuiThemePresentationOptions = {},
): TuiSemanticTheme {
  return resolvedThemeBundle(settings, options).theme
}

const TuiPaletteContext = createContext<TuiPalette>(tuiPalette('auto'))
const TuiThemeContext = createContext<TuiSemanticTheme>(
  resolveTuiTheme(DEFAULT_TUI_THEME_SETTINGS),
)

export function TuiThemeProvider({
  settings,
  screenReader = false,
  children,
}: {
  settings: TuiThemeSettings
  screenReader?: boolean
  children: ReactNode
}) {
  const environment = process.env
  const environmentKey = [
    environment.COLORFGBG,
    environment.FORCE_COLOR,
    environment.COLORTERM,
    environment.TERM,
    environment.TERM_PROGRAM,
    environment.NO_COLOR,
  ]
    .map((value) => value ?? '')
    .join('\u0000')
  const bundle = useMemo(
    () => resolvedThemeBundle(settings, { environment, screenReader }),
    [
      settings.theme,
      settings.syntaxHighlightingDisabled,
      settings.customTheme,
      screenReader,
      environmentKey,
    ],
  )
  return (
    <TuiThemeContext.Provider value={bundle.theme}>
      <TuiPaletteContext.Provider value={bundle.palette}>
        {children}
      </TuiPaletteContext.Provider>
    </TuiThemeContext.Provider>
  )
}

export function useTuiPalette(): TuiPalette {
  return useContext(TuiPaletteContext)
}

export function useTuiTheme(): TuiSemanticTheme {
  return useContext(TuiThemeContext)
}
