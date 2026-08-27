import type { TuiSemanticTheme, TuiTextRole, TuiTextStyle } from './theme.js'

const ANSI_COLORS: Readonly<Record<string, number>> = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  blackBright: 60,
  redBright: 61,
  greenBright: 62,
  yellowBright: 63,
  blueBright: 64,
  magentaBright: 65,
  cyanBright: 66,
  whiteBright: 67,
}

function colorCode(value: string, background: boolean): string | undefined {
  const ansi = ANSI_COLORS[value]
  if (ansi !== undefined) {
    const base = ansi >= 60 ? 90 : 30
    return String((background ? base + 10 : base) + (ansi % 60))
  }
  const ansi256 = /^ansi256\(([0-9]+)\)$/u.exec(value)
  if (ansi256 !== null) {
    const number = Number(ansi256[1] ?? '')
    return number >= 0 && number <= 255
      ? `${background ? 48 : 38};5;${number}`
      : undefined
  }
  const hex = /^#([0-9a-f]{6})$/iu.exec(value)
  if (hex !== null) {
    const rgb = (hex[1] ?? '').match(/../gu)
    return rgb === null
      ? undefined
      : `${background ? 48 : 38};2;${rgb.map((part) => Number.parseInt(part, 16)).join(';')}`
  }
  const rgb = /^rgb\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*\)$/u.exec(
    value,
  )
  if (rgb !== null) {
    const channels = rgb.slice(1).map(Number)
    return channels.every((channel) => channel >= 0 && channel <= 255)
      ? `${background ? 48 : 38};2;${channels.join(';')}`
      : undefined
  }
  return undefined
}

function styleSequence(style: TuiTextStyle): string | undefined {
  const codes: string[] = []
  if (style.color !== undefined) {
    const code = colorCode(style.color, false)
    if (code !== undefined) codes.push(code)
  }
  if (style.backgroundColor !== undefined) {
    const code = colorCode(style.backgroundColor, true)
    if (code !== undefined) codes.push(code)
  }
  if (style.bold) codes.push('1')
  if (style.dimColor) codes.push('2')
  if (style.italic) codes.push('3')
  if (style.underline) codes.push('4')
  if (style.inverse) codes.push('7')
  return codes.length === 0 ? undefined : `\u001b[${codes.join(';')}m`
}

export function resolveAnsiTextStyles(
  theme: Pick<TuiSemanticTheme, 'text' | 'noColor' | 'screenReader'>,
): Partial<Record<TuiTextRole, string>> {
  if (theme.noColor || theme.screenReader) return {}
  const styles: Partial<Record<TuiTextRole, string>> = {}
  for (const [role, style] of Object.entries(theme.text) as [
    TuiTextRole,
    TuiTextStyle,
  ][]) {
    const sequence = styleSequence(style)
    if (sequence !== undefined) styles[role] = sequence
  }
  return styles
}
