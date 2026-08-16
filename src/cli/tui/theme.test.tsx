import { render } from 'ink-testing-library'
import { Text } from 'ink'
import { afterEach, describe, expect, it } from 'vitest'

import {
  TUI_THEMES,
  TuiThemeProvider,
  terminalColorCapability,
  tuiPalette,
  tuiSyntaxStyle,
  useTuiPalette,
} from './theme.js'

afterEach(() => {
  delete process.env.COLORFGBG
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

describe('TUI semantic theme palettes', () => {
  it('defines a complete syntax, diff, and semantic palette for every profile', () => {
    for (const profile of TUI_THEMES) {
      const palette = tuiPalette(profile)
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
    expect(tuiPalette('dark').syntax).toEqual({
      text: '#ffffff',
      keyword: '#5fd7ff',
      identifier: '#afd700',
      string: '#d7d787',
      removedBackground: '#5f0000',
      addedBackground: '#005f00',
      addedHighlight: '#008700',
    })
    expect(tuiPalette('light').syntax).toEqual({
      text: '#303030',
      keyword: '#af005f',
      identifier: '#875faf',
      string: '#005f87',
      removedBackground: '#ffd7d7',
      addedBackground: '#d7ffd7',
      addedHighlight: '#afffaf',
    })
    expect(tuiPalette('dark-daltonized').syntax).toMatchObject({
      addedBackground: '#00005f',
      addedHighlight: '#005f87',
    })
    expect(tuiPalette('light-daltonized').syntax).toMatchObject({
      addedBackground: '#d7ffff',
      addedHighlight: '#afd7ff',
    })
  })

  it('disables every runtime syntax and diff decoration from persisted state', () => {
    expect(tuiSyntaxStyle(tuiPalette('dark'), 'keyword', 'added')).toEqual({
      color: '#5fd7ff',
      backgroundColor: '#005f00',
    })
    expect(
      tuiSyntaxStyle(tuiPalette('dark', true), 'keyword', 'added'),
    ).toEqual({})
  })

  it('resolves auto against the terminal background and provides palette context', () => {
    process.env.COLORFGBG = '15;0'
    expect(tuiPalette('auto').dark).toBe(true)
    process.env.COLORFGBG = '0;15'
    expect(tuiPalette('auto').dark).toBe(false)

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
      'light-daltonized|#005f87|GitHub|#af005f|#d7ffff',
    )
    expect(
      tuiPalette('light-daltonized', true).syntaxHighlightingDisabled,
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
      brand: 'redBright',
      accent: 'whiteBright',
      info: 'cyanBright',
      link: 'cyanBright',
      error: 'redBright',
      success: 'greenBright',
      warning: 'yellowBright',
      muted: 'white',
      selectionText: 'black',
      sessionColors: {
        red: '#dc2626',
        blue: '#2563eb',
        green: '#16a34a',
        yellow: '#ca8a04',
        purple: '#9333ea',
        orange: '#ea580c',
        pink: '#db2777',
        cyan: '#0891b2',
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

  it('pins the session color map for every profile', () => {
    expect(tuiPalette('dark').sessionColors).toEqual({
      red: '#dc2626',
      blue: '#2563eb',
      green: '#16a34a',
      yellow: '#ca8a04',
      purple: '#9333ea',
      orange: '#ea580c',
      pink: '#db2777',
      cyan: '#0891b2',
    })
    expect(tuiPalette('light').sessionColors).toEqual(
      tuiPalette('dark').sessionColors,
    )
    expect(tuiPalette('dark-ansi').sessionColors).toEqual({
      red: 'redBright',
      blue: 'blueBright',
      green: 'greenBright',
      yellow: 'yellowBright',
      purple: 'magentaBright',
      orange: 'redBright',
      pink: 'magentaBright',
      cyan: 'cyanBright',
    })
    expect(tuiPalette('light-ansi').sessionColors).toEqual({
      red: 'red',
      blue: 'blue',
      green: 'green',
      yellow: 'yellow',
      purple: 'magenta',
      orange: 'redBright',
      pink: 'magentaBright',
      cyan: 'cyan',
    })
    expect(tuiPalette('dark-daltonized').sessionColors).toEqual({
      red: '#ff6666',
      blue: '#66b2ff',
      green: '#66ff66',
      yellow: '#ffff66',
      purple: '#b266ff',
      orange: '#ffb266',
      pink: '#ff99cc',
      cyan: '#66cccc',
    })
    expect(tuiPalette('light-daltonized').sessionColors).toEqual({
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
