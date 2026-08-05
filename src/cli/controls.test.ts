import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_CLI_CONTROLS, resolveCliControls } from './controls.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('CLI controls', () => {
  it('resolves prompt files, settings, and canonical additional directories', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'praxis-cli-controls-'))
    roots.push(cwd)
    const additional = join(cwd, 'additional')
    await mkdir(additional)
    await Promise.all([
      writeFile(join(cwd, 'system.txt'), 'SYSTEM_FILE'),
      writeFile(join(cwd, 'append.txt'), 'APPEND_FILE'),
      writeFile(
        join(cwd, 'settings.json'),
        JSON.stringify({ permissions: { allow: ['Read'] } }),
      ),
    ])

    await expect(
      resolveCliControls(
        {
          ...DEFAULT_CLI_CONTROLS,
          settings: 'settings.json',
          systemPromptFile: 'system.txt',
          appendSystemPromptFile: 'append.txt',
          addDirectories: ['additional'],
        },
        cwd,
      ),
    ).resolves.toMatchObject({
      systemPrompt: 'SYSTEM_FILE',
      appendSystemPrompt: 'APPEND_FILE',
      additionalDirectories: [await realpath(additional)],
      additionalSettings: {
        path: join(cwd, 'settings.json'),
        scope: 'local',
        value: { permissions: { allow: ['Read'] } },
      },
    })
  })

  it('accepts inline settings and rejects invalid files and non-directories', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'praxis-cli-controls-'))
    roots.push(cwd)
    await writeFile(join(cwd, 'file.txt'), 'not a directory')

    await expect(
      resolveCliControls(
        {
          ...DEFAULT_CLI_CONTROLS,
          settings: '{"permissions":{"deny":["Write"]}}',
        },
        cwd,
      ),
    ).resolves.toMatchObject({
      additionalSettings: {
        path: '<command-line>',
        value: { permissions: { deny: ['Write'] } },
      },
    })
    await expect(
      resolveCliControls(
        { ...DEFAULT_CLI_CONTROLS, settings: '{invalid' },
        cwd,
      ),
    ).rejects.toThrow('Invalid settings JSON')
    await expect(
      resolveCliControls(
        { ...DEFAULT_CLI_CONTROLS, addDirectories: ['file.txt'] },
        cwd,
      ),
    ).rejects.toThrow('not a directory')
  })
})
