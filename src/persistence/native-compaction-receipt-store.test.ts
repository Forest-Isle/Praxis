import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeCompactionReceipt } from './native-compaction-receipt-store.js'
import { NativeCompactionReceiptStore } from './native-compaction-receipt-store.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function temporaryRoot(label = 'receipt'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `praxis-compaction-${label}-`))
  roots.push(root)
  return root
}

function receipt(
  overrides: Partial<NativeCompactionReceipt> = {},
): NativeCompactionReceipt {
  return {
    version: 1,
    receiptId: 'receipt-1',
    sessionId: 'session-1',
    boundaryId: 'boundary-1',
    summaryId: 'summary-1',
    trigger: 'auto',
    metric: {
      model: 'compact-model',
      usage: { inputTokens: 1, outputTokens: 2 },
      durationApiMs: 3,
      durationApiWithoutRetriesMs: 2,
    },
    costUsd: null,
    before: 'a'.repeat(64),
    after: 'b'.repeat(64),
    ...overrides,
  }
}

async function writeReceiptArtifact(
  root: string,
  value: unknown,
  sessionId = 'session-1',
  receiptId = 'receipt-1',
): Promise<string> {
  const directory = join(root, 'compaction-receipts', sessionId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${receiptId}.json`)
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  return path
}

describe('NativeCompactionReceiptStore', () => {
  it('round-trips private immutable receipt and acknowledgement artifacts', async () => {
    const root = await temporaryRoot()
    const store = new NativeCompactionReceiptStore({ sidecarRoot: root })
    const value = receipt()
    await store.prepare(value)
    await store.prepare(value)
    const receiptPath = join(
      root,
      'compaction-receipts',
      'session-1',
      'receipt-1.json',
    )
    expect((await stat(receiptPath)).mode & 0o777).toBe(0o600)
    expect((await store.list('session-1'))[0]?.acknowledged).toBe(false)

    await store.acknowledge('session-1', 'receipt-1')
    await store.acknowledge('session-1', 'receipt-1')
    const ackPath = join(
      root,
      'compaction-receipts',
      'session-1',
      'receipt-1.ack',
    )
    expect((await stat(ackPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(ackPath, 'utf8')).toBe('receipt-1\n')
    expect((await store.list('session-1'))[0]?.acknowledged).toBe(true)
    await expect(store.prepare(value)).rejects.toThrow(
      /acknowledgement already exists/u,
    )
  })

  it('returns no receipts for a missing Session', async () => {
    const store = new NativeCompactionReceiptStore({
      sidecarRoot: await temporaryRoot('missing'),
    })
    await expect(store.list('session-1')).resolves.toEqual([])
  })

  it('isolates Session-local listing from corrupt artifacts in another Session', async () => {
    const root = await temporaryRoot('isolation')
    await mkdir(join(root, 'compaction-receipts', 'session-b'), {
      recursive: true,
    })
    await writeFile(
      join(root, 'compaction-receipts', 'session-b', 'bad.json'),
      '{not-json',
    )
    const store = new NativeCompactionReceiptStore({ sidecarRoot: root })
    await expect(store.list('session-a')).resolves.toEqual([])
  })

  it('accepts only an exact duplicate prepare and preserves conflicting bytes', async () => {
    const root = await temporaryRoot('prepare-conflict')
    const store = new NativeCompactionReceiptStore({ sidecarRoot: root })
    await store.prepare(receipt())
    const path = join(
      root,
      'compaction-receipts',
      'session-1',
      'receipt-1.json',
    )
    const before = await readFile(path, 'utf8')
    await expect(
      store.prepare(receipt({ after: 'c'.repeat(64) })),
    ).rejects.toThrow(/different receipt/u)
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('rejects duplicate transaction identities before writing a second receipt', async () => {
    const root = await temporaryRoot('prepare-duplicate')
    const store = new NativeCompactionReceiptStore({ sidecarRoot: root })
    await store.prepare(receipt())
    await expect(
      store.prepare(
        receipt({
          receiptId: 'receipt-2',
          boundaryId: 'summary-1',
          summaryId: 'summary-2',
        }),
      ),
    ).rejects.toThrow(/Duplicate compaction transaction identity/u)
    await expect(store.list('session-1')).resolves.toHaveLength(1)
  })

  it('rejects a pre-existing acknowledgement without creating a receipt', async () => {
    const root = await temporaryRoot('pre-ack')
    const directory = join(root, 'compaction-receipts', 'session-1')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(join(directory, 'receipt-1.ack'), 'receipt-1\n', {
      mode: 0o600,
    })
    const store = new NativeCompactionReceiptStore({ sidecarRoot: root })
    await expect(store.prepare(receipt())).rejects.toThrow(
      /[Aa]cknowledgement/u,
    )
    await expect(store.list('session-1')).rejects.toThrow(/has no receipt/u)
  })

  it.each([
    ['unsafe receipt ID', () => receipt({ receiptId: '../escape' })],
    ['equal IDs', () => receipt({ summaryId: 'boundary-1' })],
    ['unknown version', () => ({ ...receipt(), version: 2 })],
    ['extra key', () => ({ ...receipt(), extra: true })],
    [
      'missing key',
      () => {
        const value = { ...receipt() }
        delete (value as { after?: string }).after
        return value
      },
    ],
    ['invalid fingerprint', () => receipt({ before: 'not-a-hash' })],
    ['negative cost', () => receipt({ costUsd: -1 })],
    [
      'duration-only non-null cost',
      () =>
        receipt({
          metric: {
            usage: { inputTokens: 0, outputTokens: 0 },
            durationApiMs: 1,
            durationApiWithoutRetriesMs: 1,
          },
          costUsd: 0,
        }),
    ],
    [
      'retry duration above total',
      () =>
        receipt({
          metric: {
            model: 'm',
            usage: { inputTokens: 1, outputTokens: 0 },
            durationApiMs: 1,
            durationApiWithoutRetriesMs: 2,
          },
        }),
    ],
    [
      'cache TTL subset overflow',
      () =>
        receipt({
          metric: {
            model: 'm',
            usage: {
              inputTokens: 1,
              outputTokens: 0,
              cacheCreationInputTokens: 1,
              cacheCreationInputTokens1h: 2,
            },
            durationApiMs: 1,
            durationApiWithoutRetriesMs: 1,
          },
        }),
    ],
    [
      'invalid capacity metadata',
      () =>
        receipt({
          metric: {
            model: 'm',
            usage: {
              inputTokens: 1,
              outputTokens: 0,
              contextWindow: Number.MAX_SAFE_INTEGER + 1,
            },
            durationApiMs: 1,
            durationApiWithoutRetriesMs: 1,
          },
        }),
    ],
    [
      'usage without model',
      () =>
        receipt({
          metric: {
            usage: { inputTokens: 1, outputTokens: 0 },
            durationApiMs: 1,
            durationApiWithoutRetriesMs: 1,
          },
        }),
    ],
  ])('rejects %s without writing a receipt', async (_label, createValue) => {
    const root = await temporaryRoot('invalid')
    const store = new NativeCompactionReceiptStore({ sidecarRoot: root })
    await expect(
      store.prepare(createValue() as NativeCompactionReceipt),
    ).rejects.toThrow()
    await expect(store.list('session-1')).resolves.toEqual([])
  })

  it.each([
    ['malformed JSON', '{not-json'],
    ['non-object JSON', '[]'],
  ])('fails closed while listing %s', async (_label, content) => {
    const root = await temporaryRoot('malformed')
    const path = await writeReceiptArtifact(root, receipt())
    await writeFile(path, content, { mode: 0o600 })
    const store = new NativeCompactionReceiptStore({ sidecarRoot: root })
    await expect(store.list('session-1')).rejects.toThrow()
  })

  it.each(['symlink', 'directory', 'non-private', 'oversized'] as const)(
    'rejects a %s receipt artifact',
    async (kind) => {
      const root = await temporaryRoot(`receipt-${kind}`)
      const directory = join(root, 'compaction-receipts', 'session-1')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const path = join(directory, 'receipt-1.json')
      if (kind === 'symlink') {
        const target = join(root, 'target.json')
        await writeFile(target, `${JSON.stringify(receipt())}\n`, {
          mode: 0o600,
        })
        await symlink(target, path)
      } else if (kind === 'directory') await mkdir(path)
      else if (kind === 'non-private') {
        await writeFile(path, `${JSON.stringify(receipt())}\n`, { mode: 0o644 })
        await chmod(path, 0o644)
      } else await writeFile(path, 'x'.repeat(512 * 1024 + 1), { mode: 0o600 })
      const store = new NativeCompactionReceiptStore({ sidecarRoot: root })
      await expect(store.list('session-1')).rejects.toThrow()
    },
  )

  it.each(['symlink', 'directory', 'non-private', 'conflicting'] as const)(
    'does not overwrite a %s acknowledgement artifact',
    async (kind) => {
      const root = await temporaryRoot(`ack-${kind}`)
      const store = new NativeCompactionReceiptStore({ sidecarRoot: root })
      await store.prepare(receipt())
      const path = join(
        root,
        'compaction-receipts',
        'session-1',
        'receipt-1.ack',
      )
      if (kind === 'symlink') {
        const target = join(root, 'ack-target')
        await writeFile(target, 'receipt-1\n', { mode: 0o600 })
        await symlink(target, path)
      } else if (kind === 'directory') await mkdir(path)
      else {
        await writeFile(
          path,
          kind === 'conflicting' ? 'different\n' : 'receipt-1\n',
          { mode: kind === 'non-private' ? 0o644 : 0o600 },
        )
        if (kind === 'non-private') await chmod(path, 0o644)
      }
      await expect(
        store.acknowledge('session-1', 'receipt-1'),
      ).rejects.toThrow()
      if (kind !== 'directory' && kind !== 'symlink')
        expect(await readFile(path, 'utf8')).toBe(
          kind === 'conflicting' ? 'different\n' : 'receipt-1\n',
        )
    },
  )

  it('rejects an unknown artifact and an orphan acknowledgement', async () => {
    const root = await temporaryRoot('unknown')
    const directory = join(root, 'compaction-receipts', 'session-1')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(join(directory, 'unexpected.tmp'), 'x', { mode: 0o600 })
    const store = new NativeCompactionReceiptStore({ sidecarRoot: root })
    await expect(store.list('session-1')).rejects.toThrow(/Unknown/u)
    await rm(join(directory, 'unexpected.tmp'))
    await writeFile(join(directory, 'orphan.ack'), 'orphan\n', { mode: 0o600 })
    await expect(store.list('session-1')).rejects.toThrow(/has no receipt/u)
  })

  it('rejects a symlinked Session directory', async () => {
    const root = await temporaryRoot('session-link')
    const outside = join(root, 'outside')
    await mkdir(outside)
    await mkdir(join(root, 'compaction-receipts'), { recursive: true })
    await symlink(outside, join(root, 'compaction-receipts', 'session-1'))
    const store = new NativeCompactionReceiptStore({ sidecarRoot: root })
    await expect(store.list('session-1')).rejects.toThrow(/not a directory/u)
  })

  it('rejects duplicate identities across receipt, boundary, and summary roles', async () => {
    const root = await temporaryRoot('duplicate')
    const first = receipt()
    const second = receipt({
      receiptId: 'receipt-2',
      boundaryId: first.summaryId,
      summaryId: 'summary-2',
    })
    await writeReceiptArtifact(root, first)
    await writeReceiptArtifact(root, second, 'session-1', 'receipt-2')
    const store = new NativeCompactionReceiptStore({ sidecarRoot: root })
    await expect(store.list('session-1')).rejects.toThrow(
      /Duplicate compaction transaction identity/u,
    )
  })

  it('serializes concurrent prepares without losing distinct receipts', async () => {
    const root = await temporaryRoot('concurrent')
    const first = new NativeCompactionReceiptStore({ sidecarRoot: root })
    const second = new NativeCompactionReceiptStore({ sidecarRoot: root })
    await Promise.all([
      first.prepare(receipt()),
      second.prepare(
        receipt({
          receiptId: 'receipt-2',
          boundaryId: 'boundary-2',
          summaryId: 'summary-2',
        }),
      ),
    ])
    await expect(first.list('session-1')).resolves.toHaveLength(2)
  })
})
