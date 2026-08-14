import { describe, expect, it } from 'vitest'

import { validateSedSafety } from './sed-safety.js'

describe('Claude sed constraint validation', () => {
  it.each([
    "sed -n '1,10p' input.txt",
    "sed -n -e '1p;2p' input.txt",
    "sed 's/old/new/g'",
    "timeout 5 sed -E 's/old/new/2g'",
  ])('accepts strict stdout-only sed form %s', (command) => {
    expect(validateSedSafety(command, false)).toEqual({ safe: true })
  })

  it('allows constrained in-place substitutions only in accept-edits mode', () => {
    expect(validateSedSafety("sed -i 's/old/new/g' input.txt", false)).toEqual({
      safe: false,
      reason: expect.stringContaining('requires explicit approval'),
    })
    expect(validateSedSafety("sed -i 's/old/new/g' input.txt", true)).toEqual({
      safe: true,
    })
  })

  it.each([
    "sed 'w /tmp/output' input.txt",
    "sed '1e id' input.txt",
    "sed 's/old/new/w /tmp/output' input.txt",
    "sed 's/old/new/e' input.txt",
    "sed 's/old/new/g;w /tmp/output' input.txt",
    'sed -f script.sed input.txt',
    "sed 'y/a/b/;e id' input.txt",
    "sed 's|old|new|g' input.txt",
  ])('fails closed for sed program %s', (command) => {
    expect(validateSedSafety(command, true)).toEqual({
      safe: false,
      reason: expect.stringContaining('requires explicit approval'),
    })
  })
})
