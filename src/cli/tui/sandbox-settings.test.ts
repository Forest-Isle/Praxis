import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createTuiSandboxStore,
  linuxGlobPatternWarnings,
} from './sandbox-settings.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-sandbox-settings-'))
  roots.push(root)
  const cwd = join(root, 'project')
  const configRoot = join(root, '.claude-home')
  await Promise.all([mkdir(cwd), mkdir(configRoot)])
  return {
    cwd,
    configRoot,
    path: join(cwd, '.claude', 'settings.local.json'),
    store: createTuiSandboxStore({
      configRoot,
      cwd,
      homeDirectory: root,
      environment: { CLAUDE_CODE_TMPDIR: join(root, 'tmp') },
    }),
  }
}

describe('TUI sandbox settings', () => {
  it('reports only Linux permission globs that are not trailing subtree globs', () => {
    const resources = [
      {
        path: '/workspace/.claude/settings.json',
        scope: 'project' as const,
        value: {
          permissions: {
            allow: ['Read(/cache/**)', 'Edit(/generated/*.json)'],
            deny: ['Read(/secrets/file?.txt)', 'Bash(git:*)'],
          },
        },
      },
    ]
    expect(linuxGlobPatternWarnings(resources, 'macos')).toEqual([])
    expect(linuxGlobPatternWarnings(resources, 'linux')).toEqual([
      'Edit(/generated/*.json)',
      'Read(/secrets/file?.txt)',
    ])
  })

  it('persists mode and override changes in project-local Claude settings', async () => {
    const { path, store } = await fixture()
    await store.setMode('disabled')
    await store.setAllowUnsandboxedCommands(false)

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      sandbox: {
        enabled: false,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: false,
      },
    })
  })

  it('adds quoted exclusions without replacing unrelated settings', async () => {
    const { path, store } = await fixture()
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        theme: 'dark',
        sandbox: { enabled: false, excludedCommands: ['docker:*'] },
      }),
    )

    const result = await store.exclude('"npm run test:*"')
    expect(result).toMatchObject({
      pattern: 'npm run test:*',
      settingsPath: '.claude/settings.local.json',
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      theme: 'dark',
      sandbox: {
        enabled: false,
        excludedCommands: ['docker:*', 'npm run test:*'],
      },
    })
  })

  it('rejects invalid existing exclusion settings', async () => {
    const { path, store } = await fixture()
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({ sandbox: { excludedCommands: true } }),
    )
    await expect(store.exclude('npm:*')).rejects.toThrow(
      'sandbox.excludedCommands must be an array of strings',
    )
  })
})
