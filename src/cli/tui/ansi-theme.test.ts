import { describe, expect, it } from 'vitest'
import { resolveAnsiTextStyles } from './ansi-theme.js'

describe('resolveAnsiTextStyles', () => {
  const theme = (text: Record<string, object>, flags = {}) =>
    ({
      text,
      noColor: false,
      screenReader: false,
      ...flags,
    }) as never

  it('converts ANSI16, bright, 256, RGB and attributes', () => {
    const styles = resolveAnsiTextStyles(
      theme({
        body: {
          color: 'red',
          backgroundColor: 'blueBright',
          bold: true,
          dimColor: true,
          italic: true,
          underline: true,
          inverse: true,
        },
        muted: { color: 'ansi256(123)' },
        link: { color: '#0a1b2c', backgroundColor: 'rgb(1, 2, 3)' },
      }),
    )
    expect(styles.body).toBe('\u001b[31;104;1;2;3;4;7m')
    expect(styles.muted).toBe('\u001b[38;5;123m')
    expect(styles.link).toBe('\u001b[38;2;10;27;44;48;2;1;2;3m')
  })

  it('suppresses colors and ignores unknown values', () => {
    expect(
      resolveAnsiTextStyles(
        theme({ body: { color: 'wat' }, heading: { bold: true } }),
      ),
    ).toEqual({ heading: '\u001b[1m' })
    expect(
      resolveAnsiTextStyles(
        theme({ body: { color: 'red' } }, { noColor: true }),
      ),
    ).toEqual({})
    expect(
      resolveAnsiTextStyles(
        theme({ body: { color: 'red' } }, { screenReader: true }),
      ),
    ).toEqual({})
  })
})
