import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  addTuiPermissionRule,
  loadTuiPermissionRules,
  persistTuiPermissionUpdates,
  removeTuiPermissionRule,
} from './permission-settings.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('TUI permission settings', () => {
  it('loads all Claude scopes and atomically adds a scoped rule', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-tui-permissions-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await addTuiPermissionRule({
      configRoot,
      cwd,
      behavior: 'allow',
      rule: 'Bash(npm test:*)',
      scope: 'local',
    })
    await addTuiPermissionRule({
      configRoot,
      cwd,
      behavior: 'deny',
      rule: 'Read(./secrets/**)',
      scope: 'user',
    })

    expect(await loadTuiPermissionRules(cwd, configRoot)).toEqual([
      expect.objectContaining({
        behavior: 'deny',
        rule: 'Read(./secrets/**)',
        scope: 'user',
      }),
      expect.objectContaining({
        behavior: 'allow',
        rule: 'Bash(npm test:*)',
        scope: 'local',
      }),
    ])
    const local = JSON.parse(
      await readFile(join(cwd, '.claude', 'settings.local.json'), 'utf8'),
    )
    expect(local.permissions.allow).toEqual(['Bash(npm test:*)'])
  })

  it('preserves unrelated settings and rejects malformed rule arrays', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-tui-permissions-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await addTuiPermissionRule({
      configRoot,
      cwd,
      behavior: 'ask',
      rule: 'WebFetch(domain:example.com)',
      scope: 'project',
    })
    const path = join(cwd, '.claude', 'settings.json')
    const value = JSON.parse(await readFile(path, 'utf8'))
    value.model = 'fixture-model'
    value.permissions.ask = 'invalid'
    await writeFile(path, JSON.stringify(value))

    await expect(
      addTuiPermissionRule({
        configRoot,
        cwd,
        behavior: 'ask',
        rule: 'Read',
        scope: 'project',
      }),
    ).rejects.toThrow('permissions.ask must be an array')
  })

  it('atomically removes one scoped rule and keeps Claude empty arrays', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-tui-permissions-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await addTuiPermissionRule({
      configRoot,
      cwd,
      behavior: 'allow',
      rule: 'Bash(npm test:*)',
      scope: 'local',
    })
    const [rule] = await loadTuiPermissionRules(cwd, configRoot)
    if (!rule) throw new Error('permission fixture was not loaded')

    await removeTuiPermissionRule(rule)

    const settings = JSON.parse(await readFile(rule.path, 'utf8'))
    expect(settings.permissions.allow).toEqual([])
    await expect(loadTuiPermissionRules(cwd, configRoot)).resolves.toEqual([])
  })

  it('leaves settings unchanged when the selected rule is already absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-tui-permissions-'))
    roots.push(root)
    const path = join(root, 'settings.json')
    const source = '{"permissions":{"deny":[]},"theme":"dark"}\n'
    await writeFile(path, source)

    await removeTuiPermissionRule({
      behavior: 'deny',
      rule: 'Read(./secrets/**)',
      scope: 'user',
      path,
    })

    await expect(readFile(path, 'utf8')).resolves.toBe(source)
  })

  it('persists source-shaped rule, directory, and mode updates by destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-tui-permissions-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await persistTuiPermissionUpdates({
      configRoot,
      cwd,
      updates: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
        {
          type: 'addDirectories',
          directories: ['/shared'],
          destination: 'localSettings',
        },
        {
          type: 'setMode',
          mode: 'acceptEdits',
          destination: 'localSettings',
        },
      ],
    })
    const settings = JSON.parse(
      await readFile(join(cwd, '.claude', 'settings.local.json'), 'utf8'),
    )
    expect(settings.permissions).toEqual({
      allow: ['Bash(npm test:*)'],
      additionalDirectories: ['/shared'],
      defaultMode: 'acceptEdits',
    })
  })

  it('removes normalized tool-wide rules from the selected destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-tui-permissions-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const path = join(cwd, '.claude', 'settings.local.json')
    await mkdir(join(cwd, '.claude'), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({ permissions: { allow: ['Bash(*)', 'Read'] } }),
    )

    await persistTuiPermissionUpdates({
      configRoot,
      cwd,
      updates: [
        {
          type: 'removeRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    })

    expect(JSON.parse(await readFile(path, 'utf8')).permissions.allow).toEqual([
      'Read',
    ])
  })
})
