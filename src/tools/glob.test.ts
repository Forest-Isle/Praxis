import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { RipgrepGlobSearch, type GlobSearchRequest } from './glob.js'
import type { ProcessResult } from '../platform/bounded-process-runner.js'

async function search(options: GlobSearchRequest): Promise<string> {
  const result = await new RipgrepGlobSearch({
    cwd: options.root,
    timeoutMs: 120_000,
  }).search(options)
  return result.content
}

const roots: string[] = []

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-glob-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('RipgrepGlobSearch', () => {
  const processResult = (
    overrides: Partial<ProcessResult> = {},
  ): ProcessResult => ({
    code: 0,
    stdout: '',
    stderr: '',
    output: '',
    timedOut: false,
    truncated: false,
    ...overrides,
  })

  it('forwards the exact command, environment, root, timeout, and signal', async () => {
    const calls: Array<Record<string, unknown>> = []
    const environment = {
      CLAUDE_CODE_GLOB_HIDDEN: 'false',
      CLAUDE_CODE_GLOB_NO_IGNORE: 'false',
    }
    const runner = {
      run: async (options: Record<string, unknown>) => {
        calls.push(options)
        return processResult({ stdout: 'src/a.ts\0' })
      },
    }
    const controller = new AbortController()
    const request = {
      root: '/tmp/root',
      displayRoot: '.',
      absoluteRoot: '/tmp/root',
      pattern: '*.ts',
      signal: controller.signal,
    }
    await expect(
      new RipgrepGlobSearch({
        cwd: '/tmp/ignored',
        timeoutMs: 321,
        environment,
        runner,
      }).search(request),
    ).resolves.toMatchObject({ content: 'src/a.ts', isError: false })
    expect(calls).toEqual([
      {
        command: 'rg',
        args: ['--files', '--null', '--sort', 'modified'],
        cwd: '/tmp/root',
        timeoutMs: 321,
        signal: controller.signal,
        env: environment,
      },
    ])
  })

  it('preserves default flags for non-exact false values', async () => {
    const calls: Array<Record<string, unknown>> = []
    const runner = {
      run: async (options: Record<string, unknown>) => {
        calls.push(options)
        return processResult({ stdout: 'a\0' })
      },
    }
    await new RipgrepGlobSearch({
      cwd: '/tmp/root',
      timeoutMs: 1,
      environment: {
        CLAUDE_CODE_GLOB_HIDDEN: '0',
        CLAUDE_CODE_GLOB_NO_IGNORE: '',
      },
      runner,
    }).search({
      root: '/tmp/root',
      displayRoot: '.',
      absoluteRoot: '/tmp/root',
      pattern: '',
    })
    expect(calls[0]?.args).toEqual([
      '--files',
      '--null',
      '--sort',
      'modified',
      '--hidden',
      '--no-ignore',
    ])
  })

  it('classifies runner results and failures', async () => {
    const request = {
      root: '/tmp/root',
      displayRoot: '.',
      absoluteRoot: '/tmp/root',
      pattern: '*',
    }
    const run = (result: ProcessResult) =>
      new RipgrepGlobSearch({
        cwd: '/tmp/root',
        timeoutMs: 77,
        runner: { run: async () => result },
      }).search(request)
    await expect(run(processResult({ code: 1 }))).resolves.toEqual({
      content: 'No files found',
      isError: false,
    })
    await expect(
      run(processResult({ code: 1, stderr: 'permission denied' })),
    ).rejects.toThrow(
      'Glob enumeration failed with exit code 1: permission denied',
    )
    await expect(run(processResult({ code: 2 }))).rejects.toThrow(
      'Glob enumeration failed with exit code 2',
    )
    await expect(run(processResult({ truncated: true }))).rejects.toThrow(
      'Glob enumeration failed: output truncated',
    )
    await expect(run(processResult({ timedOut: true }))).resolves.toEqual({
      content: 'Search timed out after 77ms',
      isError: true,
    })
    await expect(
      new RipgrepGlobSearch({
        cwd: '/tmp/root',
        timeoutMs: 1,
        runner: {
          run: async () => {
            throw new Error('rg missing')
          },
        },
      }).search(request),
    ).rejects.toThrow('Glob enumeration failed: rg missing')
  })

  it('handles pre-abort and preserves runner AbortError', async () => {
    const controller = new AbortController()
    controller.abort()
    let called = false
    const request = {
      root: '/tmp/root',
      displayRoot: '.',
      absoluteRoot: '/tmp/root',
      pattern: '*',
      signal: controller.signal,
    }
    await expect(
      new RipgrepGlobSearch({
        cwd: '/tmp/root',
        timeoutMs: 1,
        runner: {
          run: async () => {
            called = true
            return processResult()
          },
        },
      }).search(request),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(called).toBe(false)
    const abort = new DOMException('cancelled', 'AbortError')
    const nonAbortedRequest = { ...request }
    delete (nonAbortedRequest as { signal?: AbortSignal }).signal
    await expect(
      new RipgrepGlobSearch({
        cwd: '/tmp/root',
        timeoutMs: 1,
        runner: {
          run: async () => {
            throw abort
          },
        },
      }).search(nonAbortedRequest),
    ).rejects.toBe(abort)
  })
  it('matches hidden and ignored files recursively and sorts oldest first', async () => {
    const root = await fixtureRoot()
    await mkdir(join(root, 'src', '.hidden'), { recursive: true })
    await Promise.all([
      writeFile(join(root, '.gitignore'), 'ignored.ts\n'),
      writeFile(join(root, 'ignored.ts'), ''),
      writeFile(join(root, 'src', 'old.ts'), ''),
      writeFile(join(root, 'src', 'new.ts'), ''),
      writeFile(join(root, 'src', '.hidden', 'secret.ts'), ''),
    ])
    await Promise.all([
      utimes(join(root, 'src', 'old.ts'), 1_000, 1_000),
      utimes(join(root, 'src', '.hidden', 'secret.ts'), 2_000, 2_000),
      utimes(join(root, 'src', 'new.ts'), 3_000, 3_000),
      utimes(join(root, 'ignored.ts'), 4_000, 4_000),
    ])
    await symlink(join(root, 'src', 'old.ts'), join(root, 'linked.ts'))

    await expect(
      search({
        root,
        displayRoot: '.',
        absoluteRoot: root,
        pattern: '*.ts',
      }),
    ).resolves.toBe('src/old.ts\nsrc/.hidden/secret.ts\nsrc/new.ts\nignored.ts')
    await expect(
      search({
        root,
        displayRoot: '.',
        absoluteRoot: root,
        pattern: 'src/{old,new}.ts',
      }),
    ).resolves.toBe('src/old.ts\nsrc/new.ts')
    await expect(
      search({
        root,
        displayRoot: '.',
        absoluteRoot: root,
        pattern: 'src/@(old|new).ts',
      }),
    ).resolves.toBe('No files found')
  })

  it('supports absolute patterns and empty patterns', async () => {
    const root = await fixtureRoot()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'index.ts'), '')

    await expect(
      search({
        root,
        displayRoot: '.',
        absoluteRoot: root,
        pattern: `${root}/**/*.ts`,
      }),
    ).resolves.toBe(`${root}/src/index.ts`)
    await expect(
      search({
        root,
        displayRoot: '.',
        absoluteRoot: root,
        pattern: '',
      }),
    ).resolves.toBe('src/index.ts')
  })

  it('caps results at 100 with the Claude-compatible count suffix', async () => {
    const root = await fixtureRoot()
    await mkdir(join(root, 'many'))
    await Promise.all(
      Array.from({ length: 102 }, async (_, index) => {
        const path = join(root, 'many', `${String(index).padStart(3, '0')}.txt`)
        await writeFile(path, '')
        await utimes(path, 1_000 + index, 1_000 + index)
      }),
    )

    const result = await search({
      root,
      displayRoot: '.',
      absoluteRoot: root,
      pattern: 'many/*.txt',
    })
    const lines = result.split('\n')
    expect(lines).toHaveLength(101)
    expect(lines[0]).toBe('many/000.txt')
    expect(lines[99]).toBe('many/099.txt')
    expect(lines[100]).toBe(
      '(Showing 100 of 102 matching files; 2 more are not listed. Narrow the pattern or path to see the rest.)',
    )
  })

  it('returns the no-match result and observes cancellation', async () => {
    const root = await fixtureRoot()
    await expect(
      search({
        root,
        displayRoot: '.',
        absoluteRoot: root,
        pattern: '*.ts',
      }),
    ).resolves.toBe('No files found')

    const controller = new AbortController()
    controller.abort()
    await expect(
      search({
        root,
        displayRoot: '.',
        absoluteRoot: root,
        pattern: '',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
