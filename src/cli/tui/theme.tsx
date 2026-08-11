import { createContext, useContext, type ReactNode } from 'react'

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

export interface TuiThemeSettings {
  theme: TuiTheme
  syntaxHighlightingDisabled: boolean
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

function automaticDark(): boolean {
  const background = process.env.COLORFGBG?.split(';').at(-1)
  return background === undefined || Number(background) < 8
}

export function tuiPalette(profile: TuiTheme): TuiPalette {
  const dark =
    profile === 'auto'
      ? automaticDark()
      : profile === 'dark' ||
        profile === 'dark-daltonized' ||
        profile === 'dark-ansi'
  const ansiOnly = profile.endsWith('-ansi')
  const daltonized = profile.endsWith('-daltonized')
  const syntax: TuiSyntaxPalette = ansiOnly
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
  return {
    profile,
    dark,
    ansiOnly,
    brand: ansiOnly ? 'redBright' : '#D97757',
    accent: ansiOnly
      ? 'magentaBright'
      : daltonized
        ? dark
          ? '#5fd7ff'
          : '#005f87'
        : dark
          ? '#B8A1FF'
          : '#875faf',
    info: ansiOnly ? 'cyanBright' : dark ? '#5fd7ff' : '#005f87',
    link: ansiOnly ? 'blueBright' : dark ? '#5fafff' : '#005faf',
    error: ansiOnly ? 'redBright' : dark ? '#ff5f5f' : '#af0000',
    success: ansiOnly ? 'greenBright' : dark ? '#5fd75f' : '#008700',
    warning: ansiOnly ? 'yellowBright' : dark ? '#ffd75f' : '#875f00',
    muted: ansiOnly ? (dark ? 'white' : 'black') : dark ? '#a8a8a8' : '#585858',
    selectionText: dark ? 'black' : 'white',
    syntaxTheme: ansiOnly ? 'ansi' : dark ? 'Monokai Extended' : 'GitHub',
    syntax,
  }
}

const TuiPaletteContext = createContext<TuiPalette>(tuiPalette('auto'))

export function TuiThemeProvider({
  theme,
  children,
}: {
  theme: TuiTheme
  children: ReactNode
}) {
  return (
    <TuiPaletteContext.Provider value={tuiPalette(theme)}>
      {children}
    </TuiPaletteContext.Provider>
  )
}

export function useTuiPalette(): TuiPalette {
  return useContext(TuiPaletteContext)
}
