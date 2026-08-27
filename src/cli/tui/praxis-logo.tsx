import { Box, Text } from 'ink'

import { useTuiTheme } from './theme.js'

export const PRAXIS_LOGO_ROWS = Object.freeze([
  '╭─╮',
  '│▸│',
  '╰╲╯',
  ' ╲✦',
] as const)

export function PraxisLogo({
  screenReader = false,
}: {
  screenReader?: boolean
}) {
  const theme = useTuiTheme()

  if (screenReader) {
    return <Text {...theme.text.productIdentity}>Praxis</Text>
  }

  return (
    <Box flexDirection="column">
      {PRAXIS_LOGO_ROWS.map((row) => (
        <Text key={row} {...theme.text.productIdentity}>
          {row}
        </Text>
      ))}
    </Box>
  )
}
