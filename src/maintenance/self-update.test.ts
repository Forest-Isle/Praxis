import { describe, expect, it, vi } from 'vitest'

import { runSelfUpdate } from './self-update.js'

describe('Praxis self update', () => {
  it('installs stable by default with bounded npm execution', async () => {
    const run = vi.fn(async () => ({ stdout: 'added 1 package\n', stderr: '' }))
    const result = await runSelfUpdate({ operation: 'install', run })

    expect(run).toHaveBeenCalledWith(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      [
        'install',
        '--global',
        '--no-fund',
        '--no-audit',
        '--ignore-scripts',
        'praxis-agent@stable',
      ],
      expect.objectContaining({ timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }),
    )
    expect(result).toMatchObject({
      type: 'self-update',
      operation: 'install',
      package: 'praxis-agent',
      target: 'stable',
      force: false,
      output: 'added 1 package',
    })
  })

  it('supports exact versions, force installs, and latest updates', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: 'completed' }))
    await expect(
      runSelfUpdate({
        operation: 'install',
        target: '1.2.3-beta.1',
        force: true,
        npmExecutable: '/fixture/npm',
        run,
      }),
    ).resolves.toMatchObject({ target: '1.2.3-beta.1', force: true })
    const calls = run.mock.calls as unknown as [
      string,
      readonly string[],
      unknown,
    ][]
    expect(calls[0]?.[1]).toContain('--force')
    expect(calls[0]?.[1]).toContain('praxis-agent@1.2.3-beta.1')

    await expect(
      runSelfUpdate({ operation: 'update', run }),
    ).resolves.toMatchObject({ operation: 'update', target: 'latest' })
    expect(calls[1]?.[1]).toContain('praxis-agent@latest')
  })

  it('rejects ambiguous targets and wraps installer failures', async () => {
    await expect(
      runSelfUpdate({ operation: 'install', target: 'latest;echo bad' }),
    ).rejects.toThrow('install target must be')
    await expect(
      runSelfUpdate({
        operation: 'update',
        run: async () => {
          throw new Error('network unavailable')
        },
      }),
    ).rejects.toThrow('Praxis update failed: network unavailable')
  })
})
