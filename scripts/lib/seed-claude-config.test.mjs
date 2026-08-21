import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { seedClaudeConfig } from './seed-claude-config.mjs'

const roots = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('Claude compatibility auth seeding', () => {
  it('merges authentication defaults once without overwriting fixture state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-claude-seed-'))
    roots.push(root)
    const home = join(root, 'home')
    const config = join(root, 'config')
    await Promise.all([
      mkdir(join(home, '.claude'), { recursive: true }),
      mkdir(config, { recursive: true }),
    ])
    await Promise.all([
      writeFile(
        join(home, '.claude.json'),
        JSON.stringify({
          customApiKeyResponses: { accepted: true },
          theme: 'source',
          mcpServers: { mustNotLeak: {} },
        }),
      ),
      writeFile(
        join(home, '.claude', 'settings.json'),
        JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: 'secret',
            ANTHROPIC_MODEL: 'custom-model',
            SHARED: 'source',
          },
          enabledPlugins: { mustNotLeak: true },
          hooks: { Stop: [{ hooks: [] }] },
        }),
      ),
      writeFile(
        join(config, '.claude.json'),
        JSON.stringify({ theme: 'fixture', hasCompletedOnboarding: true }),
      ),
      writeFile(
        join(config, 'settings.json'),
        JSON.stringify({ env: { SHARED: 'fixture' }, hooks: { Stop: [] } }),
      ),
    ])

    await seedClaudeConfig(config, home)
    expect(
      JSON.parse(await readFile(join(config, '.claude.json'), 'utf8')),
    ).toEqual({
      customApiKeyResponses: { accepted: true },
      theme: 'fixture',
      hasCompletedOnboarding: true,
    })
    expect(
      JSON.parse(await readFile(join(config, 'settings.json'), 'utf8')),
    ).toEqual({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'secret',
        ANTHROPIC_MODEL: 'custom-model',
        SHARED: 'fixture',
      },
      hooks: { Stop: [] },
    })

    await writeFile(
      join(config, 'settings.json'),
      JSON.stringify({ fixture: 2 }),
    )
    await seedClaudeConfig(config, home)
    expect(
      JSON.parse(await readFile(join(config, 'settings.json'), 'utf8')),
    ).toEqual({
      fixture: 2,
    })
  })
})
