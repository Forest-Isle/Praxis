import { describe, expect, it } from 'vitest'

import { commandShell, commandShellArguments } from './command-shell.js'

describe('commandShell', () => {
  it('selects the native supported shell', () => {
    expect(commandShell('darwin')).toBe('/bin/zsh')
    expect(commandShell('linux')).toBe('/bin/bash')
    expect(() => commandShell('win32')).toThrow('unsupported on platform win32')
  })

  it('disables user startup files for child commands', () => {
    expect(commandShellArguments('printf ok', 'darwin')).toEqual([
      '-f',
      '-c',
      'printf ok',
    ])
    expect(commandShellArguments('printf ok', 'linux')).toEqual([
      '--noprofile',
      '--norc',
      '-c',
      'printf ok',
    ])
  })
})
