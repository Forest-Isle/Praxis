#!/usr/bin/env node

const VERSION = '0.1.0'

const HELP = `Praxis — local-first general agent

Usage:
  praxis [prompt]
  praxis --help
  praxis --version

Agent runtime is not implemented yet.
`

export interface CliIO {
  stdout(message: string): void
  stderr(message: string): void
}

const consoleIO: CliIO = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
}

export function run(argv: readonly string[], io: CliIO = consoleIO): number {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    io.stdout(HELP)
    return 0
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    io.stdout(`${VERSION}\n`)
    return 0
  }

  io.stderr('Praxis agent runtime is not implemented yet.\n')
  return 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = run(process.argv.slice(2))
}
