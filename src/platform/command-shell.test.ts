import { describe, expect, it } from 'vitest'

import { commandShell } from './command-shell.js'

describe('commandShell', () => {
  it('selects the native supported shell', () => {
    expect(commandShell('darwin')).toBe('/bin/zsh')
    expect(commandShell('linux')).toBe('/bin/bash')
    expect(() => commandShell('win32')).toThrow('unsupported on platform win32')
  })
})
