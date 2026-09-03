import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ExclusiveFileLease } from './exclusive-file-lease.js'

describe('ExclusiveFileLease', () => {
  it('exposes immutable owner metadata and refuses a concurrent owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-exclusive-lease-'))
    const first = new ExclusiveFileLease(join(root, 'owner.lock'))
    const second = new ExclusiveFileLease(join(root, 'owner.lock'))
    const handle = await first.tryAcquire()
    expect(handle).toMatchObject({
      token: expect.any(String),
      pid: process.pid,
      createdAt: expect.any(String),
    })
    expect(await second.tryAcquire()).toBeNull()
    await handle?.release()
    const replacement = await second.tryAcquire()
    expect(replacement?.token).not.toBe(handle?.token)
    await replacement?.release()
  })

  it('reclaims a dead-PID lock file and rotates its token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-exclusive-dead-lease-'))
    const path = join(root, 'owner.lock')
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        pid: 999_999_999,
        token: 'dead-owner',
        createdAt: '2026-08-24T00:00:00.000Z',
      }),
    )
    const handle = await new ExclusiveFileLease(path).tryAcquire()
    expect(handle?.token).toEqual(expect.any(String))
    expect(handle?.token).not.toBe('dead-owner')
    await handle?.release()
  })

  it('reclaims a PID-reused lock but retains legacy and unavailable live locks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-exclusive-reuse-lease-'))
    const make = async (value: Record<string, unknown>) => {
      const path = join(root, `${Math.random()}.lock`)
      await writeFile(path, JSON.stringify(value))
      return path
    }
    const base = {
      version: 1,
      pid: process.pid,
      token: 'old-owner',
      createdAt: '2026-08-24T00:00:00.000Z',
    }
    const reused = await new ExclusiveFileLease(
      await make({ ...base, processStart: 'old' }),
      { processStart: async () => 'new' },
    ).tryAcquire()
    expect(reused?.token).not.toBe('old-owner')
    await reused?.release()
    const legacy = await new ExclusiveFileLease(await make(base), {
      processStart: async () => 'new',
    }).tryAcquire()
    expect(legacy).toBeNull()
    const unavailable = await new ExclusiveFileLease(
      await make({ ...base, processStart: 'old' }),
      { processStart: async () => null },
    ).tryAcquire()
    expect(unavailable).toBeNull()
  })
})
