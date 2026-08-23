import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { seedClaudeConfig } from './seed-claude-config.mjs'

const roots = []
const execFileAsync = promisify(execFile)
const wrapper = fileURLToPath(new URL('../claude', import.meta.url))
const AUTHENTICATION_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
]

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('Claude compatibility auth seeding', () => {
  it('does not seed an ambient config root without an explicit compatibility opt-in', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-claude-wrapper-'))
    roots.push(root)
    const home = join(root, 'home')
    const config = join(root, 'ambient-config')
    await Promise.all([
      mkdir(join(home, '.claude'), { recursive: true }),
      mkdir(config, { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(home, '.claude.json'), '{}'),
      writeFile(join(home, '.claude', 'settings.json'), '{}'),
    ])

    const isolatedEnv = { ...process.env }
    for (const key of AUTHENTICATION_ENV_KEYS) delete isolatedEnv[key]

    await execFileAsync(wrapper, ['--version'], {
      env: {
        ...isolatedEnv,
        HOME: home,
        CLAUDE_CONFIG_DIR: config,
        PRAXIS_REAL_CLAUDE_BINARY: process.execPath,
      },
    })

    await expect(
      readFile(join(config, '.praxis-compat-auth-seeded')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(config, '.claude.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(readFile(join(config, 'settings.json'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    )

    await execFileAsync(wrapper, ['--version'], {
      env: {
        ...isolatedEnv,
        HOME: home,
        CLAUDE_CONFIG_DIR: config,
        PRAXIS_COMPAT_SEED_CLAUDE_CONFIG: '1',
        PRAXIS_REAL_CLAUDE_BINARY: process.execPath,
      },
    })
    await expect(
      readFile(join(config, '.praxis-compat-auth-seeded'), 'utf8'),
    ).resolves.toBe('')
  })

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
            ANTHROPIC_BASE_URL: 'https://host.example',
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
