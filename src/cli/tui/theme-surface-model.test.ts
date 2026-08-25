import { describe, expect, it } from 'vitest'
import { CUSTOM_THEME_TOKENS } from './custom-themes.js'
import { projectTuiThemeSurface } from './theme-surface-model.js'

const theme = {
  name: 'Ocean',
  slug: 'ocean',
  base: 'dark' as const,
  overrides: {},
}

describe('projectTuiThemeSurface', () => {
  it('projects ordered options and preserves identity/current marker', () => {
    const model = projectTuiThemeSurface({
      kind: 'theme',
      currentTheme: 'custom:ocean',
      customThemes: [theme],
      selectedIndex: 99,
      syntaxHighlightingDisabled: true,
    })
    expect(model.options.map((option) => option.id)).toEqual([
      'auto',
      'dark',
      'light',
      'dark-daltonized',
      'light-daltonized',
      'dark-ansi',
      'light-ansi',
      'custom:ocean',
      '__new__',
    ])
    expect(model.options[7]?.customTheme).toBe(theme)
    expect(model.options[7]?.current).toBe(true)
    expect(model.selectedIndex).toBe(8)
  })
  it('projects create, token, and delete states', () => {
    expect(
      projectTuiThemeSurface({
        kind: 'custom-theme-create',
        base: 'dark',
        name: '',
      }),
    ).toEqual({ kind: 'custom-theme-create', base: 'dark', name: '' })
    expect(
      projectTuiThemeSurface({
        kind: 'custom-theme-token',
        theme,
        token: 'text',
        value: '#fff',
      }),
    ).toEqual({
      kind: 'custom-theme-token',
      theme,
      token: 'text',
      value: '#fff',
    })
    expect(
      projectTuiThemeSurface({
        kind: 'custom-theme-delete',
        theme,
        selectedIndex: 3,
      }),
    ).toEqual({ kind: 'custom-theme-delete', theme, selectedIndex: 3 })
  })
  it('filters tokens and clamps editor index', () => {
    const model = projectTuiThemeSurface({
      kind: 'custom-theme-editor',
      theme,
      query: 'WARN',
      selectedIndex: 99,
    })
    expect(model.tokens).toEqual(
      CUSTOM_THEME_TOKENS.filter((token) =>
        token.toLowerCase().includes('warn'),
      ),
    )
    expect(model.selectedIndex).toBe(model.tokens.length - 1)
  })
})
