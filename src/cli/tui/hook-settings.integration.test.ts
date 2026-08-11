import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ClaudeJsonResource } from '../../compatibility/claude/shared-resources.js'
import { loadClaudeSettings } from '../../compatibility/claude/shared-resources.js'
import { projectTuiHooks } from './hook-settings.js'

const tempDirectories: string[] = []

async function writeFixture(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  )
})

describe('TUI hook settings integration', () => {
  it('reloads cwd-sensitive shared settings without writing source files', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-hook-settings-')),
    )
    tempDirectories.push(root)
    const configRoot = join(root, 'config')
    const firstCwd = join(root, 'first')
    const secondCwd = join(root, 'second')
    const userPath = join(configRoot, 'settings.json')
    const firstProjectPath = join(firstCwd, '.claude', 'settings.json')
    const firstLocalPath = join(firstCwd, '.claude', 'settings.local.json')
    const secondProjectPath = join(secondCwd, '.claude', 'settings.json')
    const sourcePaths = [
      userPath,
      firstProjectPath,
      firstLocalPath,
      secondProjectPath,
    ]
    await Promise.all([
      writeFixture(userPath, {
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'command', command: 'user hook' }] }],
        },
      }),
      writeFixture(firstProjectPath, {
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'prompt', prompt: 'first project hook' }] },
          ],
        },
      }),
      writeFixture(firstLocalPath, {
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'agent', prompt: 'first local hook' }] },
          ],
        },
      }),
      writeFixture(secondProjectPath, {
        hooks: {
          PreToolUse: [
            {
              hooks: [{ type: 'http', url: 'https://fixture.test/second' }],
            },
          ],
        },
      }),
    ])
    const originalBytes = new Map<string, string>(
      await Promise.all(
        sourcePaths.map(async (path): Promise<[string, string]> => [
          path,
          await readFile(path, 'utf8'),
        ]),
      ),
    )
    const plugin: ClaudeJsonResource = {
      path: join(root, 'plugin', 'hooks.json'),
      scope: 'user',
      plugin: true,
      pluginName: 'hooks-fixture',
      pluginSource: 'hooks-fixture@inline',
      value: {
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'command', command: 'plugin hook' }] },
          ],
        },
      },
    }

    const first = projectTuiHooks([
      ...(await loadClaudeSettings({ configRoot, cwd: firstCwd })),
      plugin,
    ])
    expect(first.hookCount).toBe(4)
    expect(
      first.events[0]?.matchers.map((matcher) => matcher.scopeLabel),
    ).toEqual([
      'User Settings',
      'Project Settings',
      'Local Settings',
      'Plugin Hooks (hooks-fixture@inline)',
    ])

    await writeFixture(firstProjectPath, {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { type: 'prompt', prompt: 'reloaded project hook' },
              { type: 'command', command: 'new hook' },
            ],
          },
        ],
      },
    })
    originalBytes.set(
      firstProjectPath,
      await readFile(firstProjectPath, 'utf8'),
    )
    const reloaded = projectTuiHooks(
      await loadClaudeSettings({ configRoot, cwd: firstCwd }),
    )
    expect(reloaded.hookCount).toBe(4)
    expect(reloaded.events[0]?.matchers[1]?.hooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'reloaded project hook' }),
        expect.objectContaining({ label: 'new hook' }),
      ]),
    )

    const second = projectTuiHooks(
      await loadClaudeSettings({ configRoot, cwd: secondCwd }),
    )
    expect(second.hookCount).toBe(2)
    expect(
      second.events[0]?.matchers.map((matcher) => matcher.scope).sort(),
    ).toEqual(['Project', 'User'])
    for (const [path, bytes] of originalBytes) {
      expect(await readFile(path, 'utf8')).toBe(bytes)
    }
  })
})
