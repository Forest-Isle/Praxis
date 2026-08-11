import { render } from 'ink-testing-library'
import { Text } from 'ink'
import { afterEach, describe, expect, it } from 'vitest'

import {
  TUI_THEMES,
  TuiThemeProvider,
  tuiPalette,
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

  it('resolves auto against the terminal background and provides palette context', () => {
    process.env.COLORFGBG = '15;0'
    expect(tuiPalette('auto').dark).toBe(true)
    process.env.COLORFGBG = '0;15'
    expect(tuiPalette('auto').dark).toBe(false)

    const app = render(
      <TuiThemeProvider theme="light-daltonized">
        <PaletteProbe />
      </TuiThemeProvider>,
    )
    expect(app.lastFrame()).toBe(
      'light-daltonized|#005f87|GitHub|#af005f|#d7ffff',
    )
  })
})
