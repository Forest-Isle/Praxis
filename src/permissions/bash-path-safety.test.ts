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
    expect(
      validateBashPathSafety("sed -n -e '1p' /outside/input.txt", {
        ...base,
        readRoots: [...base.readRoots, '/outside'],
      }),
    ).toMatchObject({ safe: false, behavior: 'ask', operation: 'write' })
  })

  it('uses the active sandbox write allowlist without bypassing nested denies', () => {
    const sandboxWriteConfig = {
      allowOnly: ['/workspace/project', '/tmp/claude'],
      denyWithinAllow: ['/tmp/claude/protected'],
    }
    expect(
      validateBashPathSafety('touch /tmp/claude/result.txt', {
        ...base,
        sandboxWriteConfig,
      }),
    ).toEqual({ safe: true })
    expect(
      validateBashPathSafety('touch /tmp/claude/protected/result.txt', {
        ...base,
        sandboxWriteConfig,
      }),
    ).toMatchObject({ safe: false, behavior: 'ask' })
    expect(
      validateBashPathSafety('touch output.txt', {
        ...base,
        sandboxWriteConfig,
      }),
    ).toMatchObject({ safe: false, behavior: 'ask' })
  })

  it('orders internal path grants between deny rules and safety/root checks', () => {
    const memoryRoot = '/config/projects/-workspace/memory'
    expect(
      validateBashPathSafety(
        'touch /config/projects/-workspace/memory/MEMORY.md',
        {
          ...base,
          internalEditableRoots: [memoryRoot],
        },
      ),
    ).toEqual({ safe: true })
    expect(
      validateBashPathSafety(
        'touch /config/projects/-workspace/memory/MEMORY.md',
        {
          ...base,
          internalEditableRoots: [memoryRoot],
          fileRule: () => 'deny',
        },
      ),
    ).toMatchObject({ safe: false, behavior: 'deny' })
    expect(
      validateBashPathSafety(
        'cat /config/projects/-workspace/session/tool-results/result.txt',
        {
          ...base,
          internalReadableRoots: ['/config/projects/-workspace'],
        },
      ),
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
      validateBashPathSafety('echo value > .praxis/settings.json', {
        ...base,
        permissionMode: 'acceptEdits',
      }),
    ).toMatchObject({ safe: false, behavior: 'ask' })
    expect(
      validateBashPathSafety('touch .praxis/worktrees/feature/output.txt', {
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
    expect(validateBashPathSafety('cd src && git status', base)).toMatchObject({
      safe: false,
      behavior: 'ask',
      reason: expect.stringContaining('bare repository'),
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

  it('checks every target in a dangling symlink chain', () => {
    const root = mkdtempSync(join(tmpdir(), 'praxis-bash-path-chain-'))
    const project = join(root, 'project')
    const outside = join(root, 'outside')
    const second = join(project, 'second')
    mkdirSync(project)
    mkdirSync(outside)
    symlinkSync(second, join(project, 'first'))
    symlinkSync(join(outside, 'missing.txt'), second)
    try {
      expect(
        validateBashPathSafety('cat first', {
          ...base,
          cwd: project,
          readRoots: [project],
          writeRoots: [project],
        }),
      ).toMatchObject({ safe: false, behavior: 'ask' })
      expect(
        validateBashPathSafety('cat first', {
          ...base,
          cwd: project,
          readRoots: ['/'],
          writeRoots: [project],
          fileRule: (_operation, path) => (path === second ? 'deny' : null),
        }),
      ).toMatchObject({ safe: false, behavior: 'deny' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ["grep --include '*.ts' -R pattern /outside/grep", '/outside/grep'],
    ['rg --type ts pattern /outside/rg', '/outside/rg'],
    ['jq --indent 2 . /outside/data.json', '/outside/data.json'],
    ['sed -f /outside/script.sed /outside/input.txt', '/outside/script.sed'],
    ['find . -newer /outside/reference', '/outside/reference'],
  ])('extracts flag-bearing command path %s', (command, expectedPath) => {
    const checked: string[] = []
    validateBashPathSafety(command, {
      ...base,
      readRoots: ['/'],
      writeRoots: ['/'],
      permissionMode: 'acceptEdits',
      fileRule: (_operation, path) => {
        checked.push(path)
        return null
      },
    })
    expect(checked).toContain(expectedPath)
  })

  it('validates a read glob base directory and resolves traversing globs in full', () => {
    const checked: string[] = []
    expect(
      validateBashPathSafety("cat '/outside/*.txt'", {
        ...base,
        readRoots: ['/'],
        fileRule: (_operation, path) => {
          checked.push(path)
          return null
        },
      }),
    ).toEqual({ safe: true })
    expect(checked).toContain('/outside')
    expect(checked).not.toContain('/outside/*.txt')
    expect(
      validateBashPathSafety("cat 'safe/../../outside/*.txt'", base),
    ).toMatchObject({ safe: false, behavior: 'ask' })
  })

  it.each([
    "touch 'GIT~1/config'",
    "touch 'settings.json. '",
    "touch '.git.CON'",
    "touch 'path/.../file'",
  ])('requires approval for suspicious write path %s', (command) => {
    expect(
      validateBashPathSafety(command, {
        ...base,
        permissionMode: 'acceptEdits',
      }),
    ).toMatchObject({
      safe: false,
      behavior: 'ask',
      reason: expect.stringContaining('suspicious path'),
      suggestions: [],
    })
  })

  it('fails closed on a Windows long-path prefix before filesystem access', () => {
    expect(
      validateBashPathSafety("touch '\\\\?\\C:\\project\\file.txt'", {
        ...base,
        permissionMode: 'acceptEdits',
      }),
    ).toMatchObject({ safe: false, behavior: 'ask' })
  })

  it('handles Windows UNC, ADS, and dangerous drive-root children', () => {
    expect(
      validateBashPathSafety("cat '//server/share/file.txt'", {
        ...base,
        platform: 'win32',
        readRoots: ['/'],
      }),
    ).toMatchObject({
      safe: false,
      reason: expect.stringContaining('UNC network'),
    })
    expect(
      validateBashPathSafety("cat '//server/share/file.txt'", {
        ...base,
        platform: 'linux',
        readRoots: ['/'],
      }),
    ).toEqual({ safe: true })
    expect(
      validateBashPathSafety("touch 'C:\\project\\file.txt:stream'", {
        ...base,
        platform: 'win32',
        permissionMode: 'acceptEdits',
      }),
    ).toMatchObject({
      safe: false,
      reason: expect.stringContaining('suspicious'),
    })
    expect(
      validateBashPathSafety("rm -rf 'C:\\Windows'", {
        ...base,
        platform: 'win32',
        permissionMode: 'acceptEdits',
        fileRule: () => 'allow',
      }),
    ).toMatchObject({
      safe: false,
      reason: expect.stringContaining('critical path'),
      suggestions: [],
    })
  })

  it('hard-denies protected writes from the protected-write callback', () => {
    const protectedWrite = (path: string) => {
      if (path === '/home/fixture/.ssh/authorized_keys') {
        return 'SSH authorized_keys is protected'
      }
      if (path === '/home/fixture/.aws/credentials') {
        return 'AWS credentials are protected'
      }
      return undefined
    }
    const options = {
      ...base,
      permissionMode: 'bypassPermissions' as const,
      protectedWrite,
    }
    expect(
      validateBashPathSafety(
        'printf secret > /home/fixture/.ssh/authorized_keys',
        options,
      ),
    ).toMatchObject({
      safe: false,
      behavior: 'deny',
      reason:
        'Refusing to write protected path: SSH authorized_keys is protected',
      path: '/home/fixture/.ssh/authorized_keys',
      operation: 'create',
    })
    expect(
      validateBashPathSafety('rm /home/fixture/.aws/credentials', options),
    ).toMatchObject({
      safe: false,
      behavior: 'deny',
      reason: 'Refusing to write protected path: AWS credentials are protected',
      path: '/home/fixture/.aws/credentials',
      operation: 'write',
    })
  })
})
