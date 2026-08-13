import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createRecentlyDeniedStore,
  recentlyDeniedPath,
} from './recently-denied.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function makeStore() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-recently-denied-'))
  roots.push(root)
  return { root, store: createRecentlyDeniedStore(root) }
}

describe('recently denied sidecar', () => {
  it('deduplicates newest-first and survives a new store instance', async () => {
    const { root, store: first } = await makeStore()
    await first.record('Bash(rm -rf /)')
    await first.record('Read(/private/secret)')
    await first.record('Bash(rm -rf /)')

    expect(await first.load()).toEqual([
      'Bash(rm -rf /)',
      'Read(/private/secret)',
    ])
    expect(await createRecentlyDeniedStore(root).load()).toEqual([
      'Bash(rm -rf /)',
      'Read(/private/secret)',
    ])
    expect(await readFile(recentlyDeniedPath(root), 'utf8')).toContain(
      'deniedAt',
    )
  })

  it('clears and removes individual entries', async () => {
    const { store: deniedStore } = await makeStore()
    await deniedStore.record('Bash(one)')
    await deniedStore.record('Bash(two)')
    expect(await deniedStore.remove('Bash(one)')).toEqual(['Bash(two)'])
    await deniedStore.clear()
    await expect(deniedStore.load()).resolves.toEqual([])
  })

  it('serializes concurrent stores without losing either denied action', async () => {
    const { root } = await makeStore()
    const first = createRecentlyDeniedStore(root)
    const second = createRecentlyDeniedStore(root)
    await Promise.all([first.record('Bash(one)'), second.record('Bash(two)')])
    expect(await createRecentlyDeniedStore(root).load()).toEqual(
      expect.arrayContaining(['Bash(one)', 'Bash(two)']),
    )
  })

  it('drops malformed and expired entries while loading', async () => {
    const { root, store: deniedStore } = await makeStore()
    await mkdir(join(root, 'praxis', 'permissions'), { recursive: true })
    await writeFile(
      recentlyDeniedPath(root),
      JSON.stringify([
        { key: 'old', display: 'old', deniedAt: Date.now() - 8 * 86_400_000 },
        { key: 'bad', display: 'bad', deniedAt: 'now' },
        { key: 'new', display: 'new', deniedAt: Date.now() },
      ]),
    )
    expect(await deniedStore.load()).toEqual(['new'])
  })
})
