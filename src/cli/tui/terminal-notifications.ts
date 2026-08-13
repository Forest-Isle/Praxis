export type TuiNotificationChannel =
  | 'auto'
  | 'iterm2'
  | 'terminal_bell'
  | 'iterm2_with_bell'
  | 'kitty'
  | 'ghostty'
  | 'notifications_disabled'

export type TuiNotificationWriter = (sequence: string) => void

function terminalProgram(
  environment: Readonly<Record<string, string | undefined>>,
): 'iterm2' | 'kitty' | 'ghostty' | undefined {
  const program = environment.TERM_PROGRAM?.toLowerCase()
  if (program === 'iterm.app') return 'iterm2'
  if (program === 'ghostty') return 'ghostty'
  if (environment.KITTY_WINDOW_ID) return 'kitty'
  return undefined
}

function escapeOsc(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code !== 7 && code !== 27
    })
    .join('')
}

function sequenceFor(
  channel: TuiNotificationChannel,
  title: string,
  message: string,
): string | undefined {
  const text = escapeOsc(`${title}: ${message}`)
  switch (channel) {
    case 'iterm2':
      return `\u001b]9;${text}\u0007`
    case 'terminal_bell':
      return '\u0007'
    case 'iterm2_with_bell':
      return `\u001b]9;${text}\u0007\u0007`
    case 'kitty':
      return `\u001b]99;i=1:d=0:p=title;${escapeOsc(title)}\u001b\\\u001b]99;i=1:d=1:p=body;${escapeOsc(message)}\u001b\\`
    case 'ghostty':
      return `\u001b]9;${text}\u0007`
    case 'auto':
    case 'notifications_disabled':
      return undefined
  }
}

export function notifyTerminal(options: {
  channel: TuiNotificationChannel
  title: string
  message: string
  environment?: Readonly<Record<string, string | undefined>>
  write?: TuiNotificationWriter
}): void {
  if (options.channel === 'notifications_disabled') return
  const environment = options.environment ?? process.env
  const selected =
    options.channel === 'auto' ? terminalProgram(environment) : options.channel
  if (!selected) return
  const sequence = sequenceFor(selected, options.title, options.message)
  if (sequence)
    (options.write ?? ((value) => process.stdout.write(value)))(sequence)
}
