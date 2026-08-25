import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SandboxManager as BaseSandboxManager } from '@anthropic-ai/sandbox-runtime'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { LocalToolRegistry } from '../tools/local-tools.js'
import { ClaudeSandboxRuntime } from './claude-sandbox-runtime.js'
import type { ClaudeSandboxSettings } from './claude-sandbox-settings.js'

const sandboxPlatform = process.platform === 'darwin' ? 'macos' : 'linux'
const describeSandbox =
  process.platform === 'darwin' || process.platform === 'linux'
    ? describe
    : describe.skip

describeSandbox(`Claude sandbox ${sandboxPlatform} integration`, () => {
  let root: string
  let cwd: string
  let outside: string
  let writeOutside: string
  let runtime: ClaudeSandboxRuntime

  const configured = (
    overrides: Partial<ClaudeSandboxSettings> = {},
  ): ClaudeSandboxSettings => ({
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: true,
    excludedCommands: [],
    bareGitRepoScrubPaths: ['HEAD', 'objects', 'refs', 'hooks', 'config'].map(
      (name) => join(cwd, name),
    ),
    runtimeConfig: {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: {
        allowWrite: [cwd],
        denyWrite: [join(cwd, '.sandbox-denied')],
        denyRead: [outside],
        allowRead: [join(outside, 'public')],
      },
    },
    ...overrides,
  })

  const bash = async (command: string, dangerouslyDisableSandbox = false) => {
    const registry = new LocalToolRegistry({ cwd, sandbox: runtime })
    const context = { cwd }
    const call = await registry.prepare(
      {
        id: `sandbox-${Math.random()}`,
        name: 'Bash',
        input: {
          command,
          ...(dangerouslyDisableSandbox
            ? { dangerouslyDisableSandbox: true }
            : {}),
        },
      },
      context,
    )
    return registry.execute(call, context)
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'praxis-sandbox-e2e-'))
    cwd = join(root, 'workspace')
    outside = join(root, 'outside')
    writeOutside = join(root, 'write-outside')
    await Promise.all([
      mkdir(join(cwd, '.sandbox-denied'), { recursive: true }),
      mkdir(join(outside, 'public'), { recursive: true }),
      mkdir(writeOutside, { recursive: true }),
    ])
    runtime = new ClaudeSandboxRuntime(
      BaseSandboxManager,
      () => sandboxPlatform,
    )
    await runtime.initialize(configured())
  })

  afterAll(async () => {
    await runtime.reset()
    await rm(root, { recursive: true, force: true })
  })

  it('allows cwd writes and blocks writes outside the allowlist', async () => {
    await expect(bash("printf 'inside' > inside.txt")).resolves.toMatchObject({
      isError: false,
    })
    await expect(readFile(join(cwd, 'inside.txt'), 'utf8')).resolves.toBe(
      'inside',
    )

    const blocked = await bash(
      `printf 'outside' > '${join(writeOutside, 'blocked.txt')}'`,
    )
    expect(blocked.isError).toBe(true)
    expect(blocked.processOutput?.stderr).toMatch(
      /sandbox|deny|operation not permitted/iu,
    )
    await expect(
      readFile(join(writeOutside, 'blocked.txt'), 'utf8'),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('keeps denyWrite and denyRead stronger than nested allows', async () => {
    const deniedWrite = await bash(
      `printf 'escape' > '${join(cwd, '.sandbox-denied', 'value.txt')}'`,
    )
    expect(deniedWrite.isError).toBe(true)

    await writeFile(join(outside, 'secret.txt'), 'secret')
    await writeFile(join(outside, 'public', 'value.txt'), 'public')
    await expect(
      bash(`cat '${join(outside, 'secret.txt')}'`),
    ).resolves.toMatchObject({ isError: true })
    await expect(
      bash(`cat '${join(outside, 'public', 'value.txt')}'`),
    ).resolves.toMatchObject({ isError: false, content: 'public' })
  })

  it('scrubs bare-repository control files planted by sandboxed commands', async () => {
    await expect(
      bash('touch HEAD config && mkdir objects refs hooks'),
    ).resolves.toMatchObject({ isError: false })
    for (const name of ['HEAD', 'config', 'objects', 'refs', 'hooks']) {
      await expect(readFile(join(cwd, name), 'utf8')).rejects.toMatchObject({
        code: expect.stringMatching(/ENOENT|EISDIR/u),
      })
    }
  })

  it('honors override policy and excluded commands', async () => {
    const overridePath = join(writeOutside, 'override.txt')
    await expect(
      bash(`printf override > '${overridePath}'`, true),
    ).resolves.toMatchObject({ isError: false })
    await expect(readFile(overridePath, 'utf8')).resolves.toBe('override')

    await runtime.initialize(configured({ allowUnsandboxedCommands: false }))
    const forced = await bash(
      `printf forced > '${join(writeOutside, 'forced.txt')}'`,
      true,
    )
    expect(forced.isError).toBe(true)

    await runtime.initialize(
      configured({
        allowUnsandboxedCommands: false,
        excludedCommands: ['printf:*'],
      }),
    )
    await expect(
      bash(`printf excluded > '${join(writeOutside, 'excluded.txt')}'`),
    ).resolves.toMatchObject({ isError: false })
  })

  it('enforces network allow and deny policy', async () => {
    await runtime.initialize(
      configured({
        allowUnsandboxedCommands: false,
        runtimeConfig: {
          network: {
            allowedDomains: ['example.com'],
            deniedDomains: [],
          },
          filesystem: configured().runtimeConfig.filesystem,
        },
      }),
    )
    const allowed = await bash(
      'curl --fail --silent --show-error --max-time 10 https://example.com',
    )
    expect(allowed.isError).toBe(false)
    expect(allowed.content).toContain('Example Domain')

    await runtime.initialize(
      configured({
        allowUnsandboxedCommands: false,
        runtimeConfig: {
          network: {
            allowedDomains: ['example.com'],
            deniedDomains: ['example.com'],
          },
          filesystem: configured().runtimeConfig.filesystem,
        },
      }),
    )
    await expect(
      bash(
        'curl --fail --silent --show-error --max-time 10 https://example.com',
      ),
    ).resolves.toMatchObject({ isError: true })
  }, 15_000)
})
