import { render } from 'ink-testing-library'
import { Text } from 'ink'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  TUI_THEMES,
  TuiThemeProvider,
  resolveTuiTheme,
  terminalColorCapability,
  tuiPalette,
  tuiSyntaxStyle,
  useTuiPalette,
  useTuiTheme,
} from './theme.js'

const ENVIRONMENT_KEYS = [
  'COLORFGBG',
  'FORCE_COLOR',
  'COLORTERM',
  'TERM',
  'TERM_PROGRAM',
  'NO_COLOR',
] as const
const TRUECOLOR_ENV = {
  TERM: 'xterm-truecolor',
  COLORTERM: 'truecolor',
  NO_COLOR: undefined,
}
const ANSI256_ENV = { TERM: 'xterm-256color', NO_COLOR: undefined }
const ANSI16_ENV = { TERM: 'xterm', NO_COLOR: undefined }
const AGENT_COLOR_NAMES = [
  'red',
  'blue',
  'green',
  'yellow',
  'purple',
  'orange',
  'pink',
  'cyan',
] as const
let environmentBeforeTest: Record<string, string | undefined>

function setProcessEnvironment(
  environment: Record<string, string | undefined>,
): void {
  for (const key of ENVIRONMENT_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) process.env[key] = value
  }
}

beforeEach(() => {
  environmentBeforeTest = Object.fromEntries(
    ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const key of ENVIRONMENT_KEYS) {
    const value = environmentBeforeTest[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function PaletteProbe() {
  const palette = useTuiPalette()
  return (
    <Text>
      {palette.profile}|{palette.accent}|{palette.syntaxTheme}|
      {palette.syntax.keyword}|{palette.syntax.addedBackground ?? 'none'}
    </Text>
  )
}

let previousTheme: ReturnType<typeof useTuiTheme> | undefined
let previousPalette: ReturnType<typeof useTuiPalette> | undefined
function ThemeIdentityProbe() {
  const theme = useTuiTheme()
  const palette = useTuiPalette()
  const same = previousTheme === theme
  const samePalette = previousPalette === palette
  previousTheme = theme
  previousPalette = palette
  return (
    <Text>{`${same}|${samePalette}|${theme.noColor}|${theme.screenReader}`}</Text>
  )
}

describe('TUI semantic theme palettes', () => {
  it('resolves a complete immutable semantic role table for every profile', () => {
    for (const profile of TUI_THEMES) {
      const theme = resolveTuiTheme(
        { theme: profile, syntaxHighlightingDisabled: false },
        { environment: TRUECOLOR_ENV },
      )
      expect(Object.keys(theme.text)).toHaveLength(20)
      expect(Object.keys(theme.surface)).toHaveLength(7)
      expect(Object.isFrozen(theme.text)).toBe(true)
      expect(Object.isFrozen(theme.surface)).toBe(true)
      expect(theme.syntax('keyword').color).toBeTruthy()
      expect(theme.session('blue')).toBeTruthy()
    }
  })

  it('suppresses semantic decoration for NO_COLOR and screen-reader presentation', () => {
    const noColor = resolveTuiTheme(
      { theme: 'dark', syntaxHighlightingDisabled: false },
      { environment: { TERM: 'xterm-truecolor', NO_COLOR: '1' } },
    )
    expect(noColor.noColor).toBe(true)
    expect(noColor.text.productIdentity.color).toBeUndefined()
    expect(noColor.surface.decision.borderColor).toBeUndefined()
    expect(noColor.syntax('keyword')).toEqual({})
    expect(noColor.session('red')).toBeUndefined()

    const screenReader = resolveTuiTheme(
      { theme: 'light', syntaxHighlightingDisabled: false },
      { environment: { TERM: 'xterm-truecolor' }, screenReader: true },
    )
    expect(screenReader.screenReader).toBe(true)
    expect(screenReader.noColor).toBe(false)
    expect(screenReader.text.heading.bold).toBe(true)
    expect(screenReader.text.selectedRow.backgroundColor).toBeUndefined()
    expect(screenReader.surface.neutralBorder).toEqual({})
  })

  it('maps legacy custom tokens into the same semantic roles', () => {
    const theme = resolveTuiTheme(
      {
        theme: 'custom:quiet',
        syntaxHighlightingDisabled: false,
        customTheme: {
          name: 'Quiet',
          slug: 'quiet',
          base: 'dark',
          overrides: {
            claude: '#010203',
            suggestion: '#040506',
            professionalBlue: '#070809',
            warning: '#0a0b0c',
            diffAdded: '#0d0e0f',
          },
        },
      },
      {
        environment: TRUECOLOR_ENV,
      },
    )
    expect(theme.text.productIdentity.color).toBe('#010203')
    expect(theme.text.focusMarker.color).toBe('#040506')
    expect(theme.text.selectedRow.color).toBe('#040506')
    expect(theme.text.selectedRow.backgroundColor).toBeUndefined()
    expect(theme.text.info.color).toBe('#070809')
    expect(theme.text.permission.color).toBe('#0a0b0c')
    expect(theme.text.diffAdded.color).toBe('#0d0e0f')
  })

  it('keeps body native, mint focus, distinct flags, and ANSI16 custom safety', () => {
    const theme = resolveTuiTheme(
      { theme: 'dark', syntaxHighlightingDisabled: false },
      {
        environment: TRUECOLOR_ENV,
      },
    )
    expect(theme.text.body).toEqual({})
    expect(theme.text.productIdentity.color).toBe('#5EE6B5')
    expect(theme.text.focusMarker.color).toBe('#5EE6B5')
    expect(theme.text.selectedRow).toMatchObject({
      color: '#5EE6B5',
      bold: true,
    })
    expect(theme.text.selectedRow.backgroundColor).toBeUndefined()
    expect(theme.text.warning.color).toBe('#F2C14E')
    expect(theme.text.error.color).toBe('#FF6B6B')
    expect(theme.text.info.color).toBe('#9AA7B8')
    expect(theme.text.inputCursor).toEqual({ inverse: true })
    const ansiTheme = resolveTuiTheme(
      {
        theme: 'custom:ansi-safe',
        syntaxHighlightingDisabled: false,
        customTheme: {
          name: 'Ansi Safe',
          slug: 'ansi-safe',
          base: 'dark',
          overrides: {
            claude: '#123456',
            suggestion: 'rgb(1,2,3)',
            diffAddedWord: 'ansi256(200)',
          },
        },
      },
      { environment: ANSI16_ENV },
    )
    const allColors = [
      ansiTheme.text.productIdentity.color,
      ansiTheme.text.focusMarker.color,
      ansiTheme.surface.input.borderColor,
      ansiTheme.syntax('text').color,
      ansiTheme.syntax('addedHighlight').backgroundColor,
      ansiTheme.session('red'),
    ]
    expect(
      allColors.every(
        (value) => value === undefined || !/[#]|rgb\(|ansi256\(/u.test(value),
      ),
    ).toBe(true)
  })

  it('memoizes provider theme and palette identities across unchanged rerenders', () => {
    setProcessEnvironment(TRUECOLOR_ENV)
    previousTheme = undefined
    previousPalette = undefined
    const settings = {
      theme: 'dark' as const,
      syntaxHighlightingDisabled: false,
    }
    const app = render(
      <TuiThemeProvider settings={settings}>
        <ThemeIdentityProbe />
      </TuiThemeProvider>,
    )
    expect(app.lastFrame()).toBe('false|false|false|false')
    app.rerender(
      <TuiThemeProvider settings={settings}>
        <ThemeIdentityProbe />
      </TuiThemeProvider>,
    )
    expect(app.lastFrame()).toBe('true|true|false|false')
  })

  it('invalidates the shared bundle for presentation, environment, and settings changes', () => {
    setProcessEnvironment(TRUECOLOR_ENV)
    previousTheme = undefined
    previousPalette = undefined
    const settings = {
      theme: 'dark' as const,
      syntaxHighlightingDisabled: false,
    }
    const app = render(
      <TuiThemeProvider settings={settings}>
        <ThemeIdentityProbe />
      </TuiThemeProvider>,
    )
    expect(app.lastFrame()).toBe('false|false|false|false')

    app.rerender(
      <TuiThemeProvider settings={settings} screenReader>
        <ThemeIdentityProbe />
      </TuiThemeProvider>,
    )
    expect(app.lastFrame()).toBe('false|false|false|true')

    setProcessEnvironment(ANSI256_ENV)
    app.rerender(
      <TuiThemeProvider settings={settings} screenReader>
        <ThemeIdentityProbe />
      </TuiThemeProvider>,
    )
    expect(app.lastFrame()).toBe('false|false|false|true')

    app.rerender(
      <TuiThemeProvider
        settings={{ ...settings, syntaxHighlightingDisabled: true }}
        screenReader
      >
        <ThemeIdentityProbe />
      </TuiThemeProvider>,
    )
    expect(app.lastFrame()).toBe('false|false|false|true')
  })

  it('defines a complete syntax, diff, and semantic palette for every profile', () => {
    for (const profile of TUI_THEMES) {
      const palette = tuiPalette(profile, false, TRUECOLOR_ENV)
      expect(palette.profile).toBe(profile)
      expect(palette.brand).toBeTruthy()
      expect(palette.accent).toBeTruthy()
      expect(palette.error).toBeTruthy()
      expect(palette.success).toBeTruthy()
      expect(palette.warning).toBeTruthy()
      expect(palette.syntax.text).toBeTruthy()
      expect(palette.syntax.keyword).toBeTruthy()
      expect(palette.syntax.identifier).toBeTruthy()
      expect(palette.syntax.string).toBeTruthy()
      if (profile.endsWith('-ansi')) {
        expect(palette.syntax.addedBackground).toBeUndefined()
        expect(palette.syntaxTheme).toBe('ansi')
      } else {
        expect(palette.syntax.removedBackground).toBeTruthy()
        expect(palette.syntax.addedBackground).toBeTruthy()
        expect(palette.syntax.addedHighlight).toBeTruthy()
      }
    }
  })

  it('matches the pinned syntax and diff palettes for profile families', () => {
    expect(tuiPalette('dark', false, TRUECOLOR_ENV).syntax).toEqual({
      text: '#ffffff',
      keyword: '#5fd7ff',
      identifier: '#afd700',
      string: '#d7d787',
      removedBackground: '#5f0000',
      addedBackground: '#005f00',
      addedHighlight: '#008700',
    })
    expect(tuiPalette('light', false, TRUECOLOR_ENV).syntax).toEqual({
      text: '#303030',
      keyword: '#af005f',
      identifier: '#875faf',
      string: '#005f87',
      removedBackground: '#ffd7d7',
      addedBackground: '#d7ffd7',
      addedHighlight: '#afffaf',
    })
    expect(
      tuiPalette('dark-daltonized', false, TRUECOLOR_ENV).syntax,
    ).toMatchObject({
      addedBackground: '#00005f',
      addedHighlight: '#005f87',
    })
    expect(
      tuiPalette('light-daltonized', false, TRUECOLOR_ENV).syntax,
    ).toMatchObject({
      addedBackground: '#d7ffff',
      addedHighlight: '#afd7ff',
    })
  })

  it('disables every runtime syntax and diff decoration from persisted state', () => {
    expect(
      tuiSyntaxStyle(
        tuiPalette('dark', false, TRUECOLOR_ENV),
        'keyword',
        'added',
      ),
    ).toEqual({
      color: '#5fd7ff',
      backgroundColor: '#005f00',
    })
    expect(
      tuiSyntaxStyle(
        tuiPalette('dark', true, TRUECOLOR_ENV),
        'keyword',
        'added',
      ),
    ).toEqual({})
  })

  it('resolves auto against the terminal background and provides palette context', () => {
    const darkEnvironment = { ...TRUECOLOR_ENV, COLORFGBG: '15;0' }
    const lightEnvironment = { ...TRUECOLOR_ENV, COLORFGBG: '0;15' }
    expect(tuiPalette('auto', false, darkEnvironment).dark).toBe(true)
    expect(tuiPalette('auto', false, lightEnvironment).dark).toBe(false)

    setProcessEnvironment(lightEnvironment)
    const app = render(
      <TuiThemeProvider
        settings={{
          theme: 'light-daltonized',
          syntaxHighlightingDisabled: true,
        }}
      >
        <PaletteProbe />
      </TuiThemeProvider>,
    )
    expect(app.lastFrame()).toBe(
      'light-daltonized|#087F5B|GitHub|#af005f|#d7ffff',
    )
    expect(
      tuiPalette('light-daltonized', true, TRUECOLOR_ENV)
        .syntaxHighlightingDisabled,
    ).toBe(true)
  })

  it('resolves auto colors against explicit terminal capabilities', () => {
    const linux256 = { TERM: 'xterm-256color' }
    expect(terminalColorCapability(linux256)).toBe('ansi256')
    expect(tuiPalette('auto', false, linux256).syntax).toMatchObject({
      keyword: 'ansi256(81)',
      identifier: 'ansi256(148)',
      removedBackground: 'ansi256(52)',
      addedBackground: 'ansi256(22)',
      addedHighlight: 'ansi256(28)',
    })

    const truecolor = { TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    expect(terminalColorCapability(truecolor)).toBe('truecolor')
    expect(tuiPalette('auto', false, truecolor).syntax.keyword).toBe('#5fd7ff')
  })

  it('uses only the exact ANSI-16 palette on basic-color terminals', () => {
    const expected = {
      profile: 'auto',
      dark: true,
      ansiOnly: false,
      syntaxHighlightingDisabled: false,
      brand: 'cyanBright',
      accent: 'cyanBright',
      info: 'cyanBright',
      link: 'cyanBright',
      error: 'redBright',
      success: 'greenBright',
      warning: 'yellowBright',
      muted: 'white',
      selectionText: 'cyanBright',
      sessionColors: {
        red: 'redBright',
        blue: 'blueBright',
        green: 'green',
        yellow: 'yellow',
        purple: 'magenta',
        orange: 'redBright',
        pink: 'magenta',
        cyan: 'cyan',
      },
      syntaxTheme: 'Monokai Extended',
      syntax: {
        text: 'whiteBright',
        keyword: 'cyanBright',
        identifier: 'yellowBright',
        string: 'whiteBright',
        removedBackground: 'black',
        addedBackground: 'black',
        addedHighlight: 'green',
      },
    }
    const environments = [
      { TERM: 'xterm' },
      { TERM: 'dumb' },
      { TERM: 'xterm-256color', FORCE_COLOR: '1' },
    ]
    for (const environment of environments) {
      expect(terminalColorCapability(environment)).toBe('ansi16')
      expect(tuiPalette('auto', false, environment)).toEqual(expected)
    }
  })

  it('projects every custom palette, semantic, syntax, and session color safely', () => {
    const customTheme = {
      name: 'Projection Fixture',
      slug: 'projection-fixture',
      base: 'dark' as const,
      overrides: {
        claude: '#ff0000',
        suggestion: '#00ff00',
        professionalBlue: 'rgb(0,0,255)',
        ide: 'ansi256(0)',
        error: 'ansi256(1)',
        success: 'ansi256(200)',
        warning: 'ansi:yellowBright',
        inactive: '#123456',
        inverseText: 'rgb(255,255,255)',
        text: '#abcdef',
        claudeBlue_FOR_SYSTEM_SPINNER: '#ff00ff',
        diffRemoved: 'ansi256(200)',
        diffAdded: 'rgb(0,255,0)',
        diffAddedWord: '#00ff00',
      },
    }
    const ansi16Palette = tuiPalette('dark', false, ANSI16_ENV, customTheme)
    const ansi16Theme = resolveTuiTheme(
      {
        theme: 'custom:projection-fixture',
        syntaxHighlightingDisabled: false,
        customTheme,
      },
      { environment: ANSI16_ENV },
    )
    const paletteColors = [
      ansi16Palette.brand,
      ansi16Palette.accent,
      ansi16Palette.info,
      ansi16Palette.link,
      ansi16Palette.error,
      ansi16Palette.success,
      ansi16Palette.warning,
      ansi16Palette.muted,
      ansi16Palette.selectionText,
      ...Object.values(ansi16Palette.sessionColors),
      ...Object.values(ansi16Palette.syntax),
    ]
    const semanticColors = [
      ...Object.values(ansi16Theme.text).flatMap((style) => [
        style.color,
        style.backgroundColor,
      ]),
      ...Object.values(ansi16Theme.surface).flatMap((style) => [
        style.borderColor,
        style.backgroundColor,
      ]),
      ...(
        ['text', 'keyword', 'identifier', 'string', 'addedHighlight'] as const
      ).flatMap((token) =>
        ([undefined, 'added', 'removed'] as const).flatMap((change) => {
          const style = ansi16Theme.syntax(token, change)
          return [style.color, style.backgroundColor]
        }),
      ),
      ...AGENT_COLOR_NAMES.map((name) => ansi16Theme.session(name)),
    ]
    const allAnsi16Colors = [...paletteColors, ...semanticColors].filter(
      (value): value is string => value !== undefined,
    )
    expect(
      allAnsi16Colors.every(
        (value) =>
          !value.includes('#') &&
          !value.includes('rgb(') &&
          !value.includes('ansi256('),
      ),
    ).toBe(true)
    expect(ansi16Palette.brand).toBe('redBright')
    expect(ansi16Palette.accent).toBe('greenBright')
    expect(ansi16Palette.info).toBe('blueBright')
    expect(ansi16Palette.error).toBe('red')
    expect(ansi16Palette.syntax.addedHighlight).toBe('greenBright')
    expect(ansi16Theme.text.diffAdded.color).toBe('greenBright')
    expect(ansi16Theme.text.diffRemoved.color).toBe('magentaBright')
    const ansi16Names = [
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
    ]
    for (const [index, name] of ansi16Names.entries()) {
      const directAnsi = {
        ...customTheme,
        overrides: { ...customTheme.overrides, claude: `ansi256(${index})` },
      }
      expect(
        resolveTuiTheme(
          {
            theme: 'custom:projection-fixture',
            syntaxHighlightingDisabled: false,
            customTheme: directAnsi,
          },
          { environment: ANSI16_ENV },
        ).text.productIdentity.color,
      ).toBe(name)
    }

    const ansi256Theme = resolveTuiTheme(
      {
        theme: 'custom:projection-fixture',
        syntaxHighlightingDisabled: false,
        customTheme,
      },
      { environment: ANSI256_ENV },
    )
    expect(ansi256Theme.terminalColorCapability).toBe('ansi256')
    expect(ansi256Theme.text.productIdentity.color).toBe('ansi256(196)')
    expect(ansi256Theme.text.selectedRow.color).toBe('ansi256(46)')
    expect(ansi256Theme.text.selectedRow.backgroundColor).toBeUndefined()
    expect(ansi256Theme.text.info.color).toBe('ansi256(21)')
    expect(ansi256Theme.text.warning.color).toBe('yellowBright')
    expect(ansi256Theme.text.error.color).toBe('ansi256(1)')
    expect(ansi256Theme.text.link.color).toBe('ansi256(0)')

    const truecolorTheme = resolveTuiTheme(
      {
        theme: 'custom:projection-fixture',
        syntaxHighlightingDisabled: false,
        customTheme,
      },
      { environment: TRUECOLOR_ENV },
    )
    expect(truecolorTheme.text.productIdentity.color).toBe('#ff0000')
    expect(truecolorTheme.text.selectedRow.color).toBe('#00ff00')
    expect(truecolorTheme.text.selectedRow.backgroundColor).toBeUndefined()
    expect(truecolorTheme.text.info.color).toBe('rgb(0,0,255)')
    expect(truecolorTheme.text.warning.color).toBe('yellowBright')
    expect(truecolorTheme.text.link.color).toBe('ansi256(0)')
  })

  it('pins the session color map for every profile', () => {
    expect(tuiPalette('dark', false, TRUECOLOR_ENV).sessionColors).toEqual({
      red: '#dc2626',
      blue: '#2563eb',
      green: '#16a34a',
      yellow: '#ca8a04',
      purple: '#9333ea',
      orange: '#ea580c',
      pink: '#db2777',
      cyan: '#0891b2',
    })
    expect(tuiPalette('light', false, TRUECOLOR_ENV).sessionColors).toEqual(
      tuiPalette('dark', false, TRUECOLOR_ENV).sessionColors,
    )
    expect(tuiPalette('dark-ansi', false, TRUECOLOR_ENV).sessionColors).toEqual(
      {
        red: 'redBright',
        blue: 'blueBright',
        green: 'greenBright',
        yellow: 'yellowBright',
        purple: 'magentaBright',
        orange: 'redBright',
        pink: 'magentaBright',
        cyan: 'cyanBright',
      },
    )
    expect(
      tuiPalette('light-ansi', false, TRUECOLOR_ENV).sessionColors,
    ).toEqual({
      red: 'red',
      blue: 'blue',
      green: 'green',
      yellow: 'yellow',
      purple: 'magenta',
      orange: 'redBright',
      pink: 'magentaBright',
      cyan: 'cyan',
    })
    expect(
      tuiPalette('dark-daltonized', false, TRUECOLOR_ENV).sessionColors,
    ).toEqual({
      red: '#ff6666',
      blue: '#66b2ff',
      green: '#66ff66',
      yellow: '#ffff66',
      purple: '#b266ff',
      orange: '#ffb266',
      pink: '#ff99cc',
      cyan: '#66cccc',
    })
    expect(
      tuiPalette('light-daltonized', false, TRUECOLOR_ENV).sessionColors,
    ).toEqual({
      red: '#cc0000',
      blue: '#0066cc',
      green: '#00cc00',
      yellow: '#ffcc00',
      purple: '#800080',
      orange: '#ff8000',
      pink: '#ff66b2',
      cyan: '#00b2b2',
    })
  })
})
