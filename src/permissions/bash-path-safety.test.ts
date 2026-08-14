import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateBashPathSafety } from './bash-path-safety.js'

const base = {
  cwd: '/workspace/project',
  homeDirectory: '/home/fixture',
  readRoots: ['/workspace/project'],
  writeRoots: ['/workspace/project'],
  permissionMode: 'default' as const,
}

describe('Claude Bash path safety', () => {
  it('requires approval for dangerous removals even when file access is allowed', () => {
    expect(
      validateBashPathSafety('timeout 5 rm -rf /', {
        ...base,
        permissionMode: 'acceptEdits',
        fileRule: () => 'allow',
      }),
    ).toMatchObject({
      safe: false,
      behavior: 'ask',
      reason: expect.stringContaining('critical path'),
      suggestions: [],
    })
  })

  it('validates output redirects and ignores descriptor duplication and /dev/null', () => {
    expect(
      validateBashPathSafety('npm test > /outside/result.log 2>&1', base),
    ).toMatchObject({
      safe: false,
      behavior: 'ask',
      path: '/outside/result.log',
    })
    expect(validateBashPathSafety('npm test > /dev/null 2>&1', base)).toEqual({
      safe: true,
    })
  })

  it('uses Read/Edit file rules after root and mode checks', () => {
    expect(
      validateBashPathSafety('cat /outside/input.txt', base),
    ).toMatchObject({
      safe: false,
      behavior: 'ask',
      path: '/outside/input.txt',
    })
    expect(
      validateBashPathSafety('cat /outside/input.txt', {
        ...base,
        fileRule: (operation) => (operation === 'read' ? 'allow' : null),
      }),
    ).toEqual({ safe: true })
    expect(validateBashPathSafety('touch output.txt', base)).toMatchObject({
      safe: false,
      behavior: 'ask',
      path: '/workspace/project/output.txt',
    })
    expect(
      validateBashPathSafety('touch output.txt', {
        ...base,
        permissionMode: 'acceptEdits',
      }),
    ).toEqual({ safe: true })
  })

  it('keeps sensitive files outside accept-edits auto approval', () => {
    expect(
      validateBashPathSafety('cp source .git/config', {
        ...base,
        permissionMode: 'acceptEdits',
      }),
    ).toMatchObject({
      safe: false,
      behavior: 'ask',
      reason: expect.stringContaining('sensitive file'),
    })
    expect(
      validateBashPathSafety('echo value > .claude/settings.json', {
        ...base,
        permissionMode: 'acceptEdits',
      }),
    ).toMatchObject({ safe: false, behavior: 'ask' })
  })

  it('fails closed on path-affecting flags, expansion, and cd compounds', () => {
    expect(
      validateBashPathSafety('cp --target-directory=/outside source', base),
    ).toMatchObject({ safe: false, reason: expect.stringContaining('flags') })
    expect(validateBashPathSafety('touch ~/../output', base)).toMatchObject({
      safe: false,
      behavior: 'ask',
    })
    expect(validateBashPathSafety('touch "*.txt"', base)).toMatchObject({
      safe: false,
      reason: expect.stringContaining('Glob patterns'),
    })
    expect(
      validateBashPathSafety('cd generated && touch output.txt', {
        ...base,
        permissionMode: 'acceptEdits',
      }),
    ).toMatchObject({
      safe: false,
      reason: expect.stringContaining('directory changes'),
    })
  })

  it('honors explicit file deny rules before other path outcomes', () => {
    expect(
      validateBashPathSafety('cat input.txt', {
        ...base,
        fileRule: () => 'deny',
      }),
    ).toMatchObject({ safe: false, behavior: 'deny' })
  })

  it('checks both lexical and symlink-resolved path representations', () => {
    const root = mkdtempSync(join(tmpdir(), 'praxis-bash-path-'))
    const project = join(root, 'project')
    const outside = join(root, 'outside')
    mkdirSync(project)
    mkdirSync(outside)
    symlinkSync(outside, join(project, 'linked'))
    try {
      expect(
        validateBashPathSafety('cat linked/secret.txt', {
          ...base,
          cwd: project,
          readRoots: [project],
          writeRoots: [project],
        }),
      ).toMatchObject({
        safe: false,
        behavior: 'ask',
        path: join(project, 'linked', 'secret.txt'),
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
