import { describe, expect, it } from 'vitest'

import { run, type CliIO } from './cli.js'

function captureIO() {
  const stdout: string[] = []
  const stderr: string[] = []
  const io: CliIO = {
    stdout: message => stdout.push(message),
    stderr: message => stderr.push(message),
  }

  return { io, stdout, stderr }
}

describe('Praxis CLI', () => {
  it('prints help by default', () => {
    const capture = captureIO()

    expect(run([], capture.io)).toBe(0)
    expect(capture.stdout.join('')).toContain('Praxis')
    expect(capture.stderr).toEqual([])
  })

  it('prints the version', () => {
    const capture = captureIO()

    expect(run(['--version'], capture.io)).toBe(0)
    expect(capture.stdout).toEqual(['0.1.0\n'])
  })

  it('fails clearly until the runtime exists', () => {
    const capture = captureIO()

    expect(run(['hello'], capture.io)).toBe(1)
    expect(capture.stderr.join('')).toContain('not implemented')
  })
})
