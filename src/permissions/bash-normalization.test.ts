import { describe, expect, it } from 'vitest'

import {
  shellPermissionMatchCandidates,
  stripAllLeadingShellEnvironment,
  stripSafeShellWrappers,
} from './bash-normalization.js'

describe('Claude Bash permission normalization', () => {
  it('strips safe environment assignments only before wrappers', () => {
    expect(stripSafeShellWrappers('NODE_ENV=test timeout 5 npm test')).toBe(
      'npm test',
    )
    expect(stripSafeShellWrappers('CUSTOM=test timeout 5 npm test')).toBe(
      'CUSTOM=test timeout 5 npm test',
    )
    expect(stripSafeShellWrappers('nohup NODE_ENV=test npm test')).toBe(
      'NODE_ENV=test npm test',
    )
    expect(stripSafeShellWrappers('NODE_ENV=$(id) npm test')).toBe(
      'NODE_ENV=$(id) npm test',
    )
  })

  it('normalizes the supported wrapper forms and rejects ambiguous flags', () => {
    expect(
      stripSafeShellWrappers(
        'timeout --foreground -k 5 --signal=TERM 10s nice -n -2 stdbuf -o0 -e L nohup -- npm test',
      ),
    ).toBe('npm test')
    expect(stripSafeShellWrappers('nice -10 git status')).toBe('git status')
    expect(stripSafeShellWrappers('env -i -u HOME FOO=bar npm test')).toBe(
      'npm test',
    )
    expect(stripSafeShellWrappers('env -S "npm test"')).toBe(
      'env -S "npm test"',
    )
    expect(stripSafeShellWrappers('timeout -k$(id) 10 npm test')).toBe(
      'timeout -k$(id) 10 npm test',
    )
    expect(stripSafeShellWrappers('stdbuf --output 0 npm test')).toBe(
      'stdbuf --output 0 npm test',
    )
  })

  it('strips broad but non-expanding environment forms for deny and ask rules', () => {
    expect(stripAllLeadingShellEnvironment("FOO='a b' BAR=a\\ b rm x")).toBe(
      'rm x',
    )
    expect(stripAllLeadingShellEnvironment('A[0]=x B+=y rm x')).toBe('rm x')
    expect(stripAllLeadingShellEnvironment('FOO=$(id) rm x')).toBe(
      'FOO=$(id) rm x',
    )
  })

  it('reaches a fixed point for interleaved wrappers and deny environments', () => {
    expect(
      shellPermissionMatchCandidates(
        'nohup FOO=bar timeout 5 nice -2 rm output.txt',
        true,
      ),
    ).toContain('rm output.txt')
  })

  it('removes full-line comments without crossing command boundaries', () => {
    expect(stripSafeShellWrappers('# note\nNODE_ENV=test npm test')).toBe(
      'npm test',
    )
    expect(stripSafeShellWrappers('NODE_ENV=test\nnpm test')).toBe(
      'NODE_ENV=test\nnpm test',
    )
  })
})
