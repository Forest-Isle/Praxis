import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { UnknownCostSidecar } from './unknown-cost-sidecar.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-unknown-cost-sidecar-'))
  roots.push(root)
  const sidecarPath = join(
    root,
    'config',
    'praxis',
    'unknown-cost-sidecar.json',
  )
  const lockFile = join(
    root,
    'config',
    'praxis',
    'locks',
    'unknown-cost-sidecar.lock',
  )
  await mkdir(dirname(sidecarPath), { recursive: true })
  await mkdir(dirname(lockFile), { recursive: true })
  const sidecar = new UnknownCostSidecar({ sidecarPath, lockFile })
  return { root, sidecarPath, sidecar }
}

async function writeRaw(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

describe('UnknownCostSidecar', () => {
  it('reads false for a missing sidecar', async () => {
    const { sidecar } = await fixture()

    await expect(sidecar.readFlag('session-a')).resolves.toBe(false)
  })

  it('round-trips a flag for a single session', async () => {
    const { sidecar } = await fixture()

    await sidecar.writeFlag('session-a', true)
    await expect(sidecar.readFlag('session-a')).resolves.toBe(true)

    await sidecar.writeFlag('session-a', false)
    await expect(sidecar.readFlag('session-a')).resolves.toBe(false)
  })

  it('isolates flags by session ID and retains other sessions on save', async () => {
    const { sidecar } = await fixture()

    await sidecar.writeFlag('session-a', true)
    await sidecar.writeFlag('session-b', false)
    await sidecar.writeFlag('session-c', true)

    await expect(sidecar.readFlag('session-a')).resolves.toBe(true)
    await expect(sidecar.readFlag('session-b')).resolves.toBe(false)
    await expect(sidecar.readFlag('session-c')).resolves.toBe(true)
    await expect(sidecar.readFlag('session-missing')).resolves.toBe(false)
  })

  it('fails closed on malformed JSON and invalid document shapes', async () => {
    const { sidecarPath, sidecar } = await fixture()
    const cases = [
      '{bad',
      JSON.stringify({ version: 2, sessions: {} }),
      JSON.stringify({ version: 1, sessions: [] }),
      JSON.stringify({
        version: 1,
        sessions: { 'session-a': { hasUnknownModelCost: 'yes' } },
      }),
      JSON.stringify({
        version: 1,
        sessions: { ' ': { hasUnknownModelCost: true } },
      }),
    ]

    for (const content of cases) {
      await writeRaw(sidecarPath, content)
      await expect(sidecar.readFlag('session-a')).resolves.toBe(false)
    }
  })

  it('writes an atomically formatted document', async () => {
    const { sidecarPath, sidecar } = await fixture()

    await sidecar.writeFlag('session-a', true)

    const content = await readFile(sidecarPath, 'utf8')
    expect(content.endsWith('\n')).toBe(true)
    expect(JSON.parse(content)).toEqual({
      version: 1,
      sessions: { 'session-a': { hasUnknownModelCost: true } },
    })
  })
})
