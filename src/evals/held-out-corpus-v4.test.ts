import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadHeldOutCorpus } from './held-out-corpus.js'

const root = fileURLToPath(
  new URL(
    '../../test/corpora/project-evals/praxis-held-out-v4',
    import.meta.url,
  ),
)
const DIGEST =
  'sha256:a32cb478cd6a99971cb57964c82affa3296546c387a4f1dacf4df7d313480b53'
const matrix = {
  'csv-lens': [
    'csv-lens.parse-quoted-row',
    'csv-lens.reject-ragged-records',
    'csv-lens.select-columns',
    'csv-lens.stable-serialize',
  ],
  'memo-lru': [
    'memo-lru.cache-undefined-values',
    'memo-lru.dedupe-concurrent-loads',
    'memo-lru.evict-least-recent',
    'memo-lru.expire-with-clock',
  ],
  'patch-tree': [
    'patch-tree.apply-atomic-batch',
    'patch-tree.decode-pointer-tokens',
    'patch-tree.prevent-prototype-pollution',
    'patch-tree.remove-array-element',
  ],
} as const
const target = {
  'csv-lens': 'src/csv.mjs',
  'memo-lru': 'src/cache.mjs',
  'patch-tree': 'src/patch.mjs',
} as const
const taskContracts: Record<
  string,
  {
    readonly exportName: string
    readonly risk: 'medium' | 'high'
    readonly prompt: string
  }
> = {
  'csv-lens.parse-quoted-row': {
    exportName: 'parseCsvRow',
    risk: 'medium',
    prompt:
      'In src/csv.mjs, export parseCsvRow(value). Parse comma-separated fields including quoted commas, doubled quote escapes, and empty fields: a,"b,c","d""e", must return ["a","b,c","d\\"e",""] and "" must return [""]. Throw for an unterminated quoted field and for any character after a closing quote other than a comma or end of input, including "a"x,b.',
  },
  'csv-lens.reject-ragged-records': {
    exportName: 'parseCsvTable',
    risk: 'medium',
    prompt:
      'In src/csv.mjs, export parseCsvTable(value). Accept LF and CRLF row separators and one final newline without producing an extra empty row, and use the first row width as the table contract. The input a,b\\r\\n1,2\\r\\n3,4\\r\\n must return [["a","b"],["1","2"],["3","4"]]. For the first ragged data row, throw exactly Row <n> has <actual> fields; expected <expected> with one-based row numbers; a,b,c\\n1,2,3\\n4,5\\n must throw Row 3 has 2 fields; expected 3.',
  },
  'csv-lens.select-columns': {
    exportName: 'selectColumns',
    risk: 'medium',
    prompt:
      'In src/csv.mjs, export selectColumns(rows, names). Treat row zero as the header, preserve requested column order, and return new outer and inner arrays without mutating or aliasing the input. For [["id","name","role"],["1","Ada","admin"],["2","Lin","dev"]] and ["role","id"], return [["role","id"],["admin","1"],["dev","2"]]. Duplicate requested id must throw exactly Duplicate column: id, and missing requested missing must throw exactly Unknown column: missing.',
  },
  'csv-lens.stable-serialize': {
    exportName: 'serializeCsv',
    risk: 'medium',
    prompt:
      'In src/csv.mjs, export serializeCsv(rows). Emit LF-separated rows with exactly one trailing newline, minimally quote only fields containing comma, quote, CR, or LF, double embedded quotes, stringify scalar values deterministically, and never mutate the input. For [["plain","a,b","say \\"hi\\"","line\\nbreak",""],[1,false,null,undefined,"x"]], return exactly plain,"a,b","say ""hi""","line\\nbreak",\\n1,false,null,undefined,x\\n.',
  },
  'memo-lru.cache-undefined-values': {
    exportName: 'createMemoCache',
    risk: 'medium',
    prompt:
      'In src/cache.mjs, export createMemoCache(), returning an object with async getOrLoad(key, loader). Distinguish an absent key from cached undefined: two sequential reads of one key whose loader resolves undefined must call it exactly once and both resolve undefined. Treat cached 0 as a hit, and load a different key independently.',
  },
  'memo-lru.dedupe-concurrent-loads': {
    exportName: 'createMemoCache',
    risk: 'high',
    prompt:
      'In src/cache.mjs, export createMemoCache(), returning an object with async getOrLoad(key, loader). Calls for the same key made before one deferred loader settles must invoke that loader exactly once and all resolve the same value identity. If a shared loader rejects, all waiters must reject with that same error, pending state must clear, and the next call for that key must invoke a new loader and be able to succeed.',
  },
  'memo-lru.evict-least-recent': {
    exportName: 'LruCache',
    risk: 'medium',
    prompt:
      'In src/cache.mjs, export constructible LruCache(capacity) with set(key, value), get(key), has(key), and size. Capacity must be a positive integer. With capacity 2, set a and b, successfully get a to refresh recency, then set c so b is evicted. Updating a must not grow size, and setting d next must evict c. A missing get returns undefined.',
  },
  'memo-lru.expire-with-clock': {
    exportName: 'TimedLruCache',
    risk: 'medium',
    prompt:
      'In src/cache.mjs, export constructible TimedLruCache(capacity, { now }) with set(key, value, ttlMs), get(key), has(key), and size. Capacity must be a positive integer and TTL must be finite and nonnegative. Expiry occurs exactly when now() >= expiresAt; expired entries act absent and are removed. A successful read before expiry refreshes LRU recency without extending expiry. With capacity 2 at time 0, set a with TTL 10 and b with TTL 100; at time 5 get a then set c with TTL 100 so b is evicted; at time 10 a is expired while c remains.',
  },
  'patch-tree.apply-atomic-batch': {
    exportName: 'applyPatch',
    risk: 'high',
    prompt:
      'In src/patch.mjs, export applyPatch(document, operations) for JSON-compatible add, replace, and remove operations on object keys and array indices. Return a structurally independent result and never mutate the input. Replacing /user/name with Lin, adding /user/active true, then removing /list/0 from {"user":{"name":"Ada"},"list":["a","b"]} must return {"user":{"name":"Lin","active":true},"list":["b"]}. Array add inserts, array replace replaces, and object remove deletes. If any later operation is invalid, including replace /missing/value, throw without mutating the original or exposing a partial result.',
  },
  'patch-tree.decode-pointer-tokens': {
    exportName: 'parsePointer',
    risk: 'medium',
    prompt:
      'In src/patch.mjs, export parsePointer(pointer). Return [] for the empty root pointer. Require every non-root pointer to begin with /, preserve empty path segments, and decode valid JSON Pointer escapes left-to-right so /a~1b/~0c/ returns ["a/b","~c",""] by mapping ~1 to / and ~0 to ~. Reject malformed escapes and non-leading-slash inputs, including /a~2b, a/b, and /~.',
  },
  'patch-tree.prevent-prototype-pollution': {
    exportName: 'applyPatch',
    risk: 'high',
    prompt:
      'In src/patch.mjs, export applyPatch(document, operations). Before cloning, reading, or writing the document, reject every patch path containing an exact decoded token __proto__, prototype, or constructor. Dangerous add operations must throw while leaving the input and global object prototypes unchanged. Similar ordinary keys remain valid: adding /constructorName is allowed, returns an independent result, and does not mutate the input.',
  },
  'patch-tree.remove-array-element': {
    exportName: 'removeAtPointer',
    risk: 'medium',
    prompt:
      'In src/patch.mjs, export removeAtPointer(document, pointer). Immutably remove an exact canonical numeric array index with left shift. Removing /items/1 from {"items":["a","b","c"],"keep":{"x":1}} must return {"items":["a","c"],"keep":{"x":1}} with independent outer and nested containers while preserving the input. Reject -, leading-zero, negative, out-of-range, and nonnumeric indices plus missing paths and intermediate non-containers, including /items/-, /items/01, /items/-1, /items/3, /items/x, /missing/0, and /keep/x/value, without mutating the input.',
  },
}

function requireTaskContract(name: string) {
  const contract = taskContracts[name]
  if (!contract) throw new Error(`Missing task contract: ${name}`)
  return contract
}

function verifierResult(
  command: string,
  args: readonly string[],
  fixture: string,
) {
  return spawnSync(command, [...args, fixture], {
    env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH },
    encoding: 'utf8',
  })
}

describe('praxis-held-out-v4 corpus contract', () => {
  it('loads the frozen corpus and exact task matrix', async () => {
    const corpus = await loadHeldOutCorpus(root)
    expect(corpus).toMatchObject({
      schemaVersion: '1.0',
      id: 'praxis-held-out-v4',
      version: 4,
      split: 'held-out',
      repetitions: 3,
      taskCount: 12,
      plannedRunCount: 36,
      contentSha256: DIGEST,
    })
    expect(corpus.policy).toEqual({
      execution: 'opt-in-only',
      tuning: 'forbidden',
      resultInformedChanges: 'require-new-version',
    })
    expect(corpus.repositories.map((r) => [r.id, r.tasks])).toEqual(
      Object.entries(matrix),
    )
    for (const repository of corpus.repositories) {
      expect(repository.cases).toHaveLength(4)
      expect(repository.cases.map((item) => item.name)).toEqual(
        matrix[repository.id as keyof typeof matrix],
      )
      for (const item of repository.cases) {
        const contract = requireTaskContract(item.name)
        expect(item.risk).toBe(contract.risk)
        expect(item.runs).toBe(3)
        expect(item.execution.model).toBeUndefined()
        expect(item.execution.prompt).toBe(contract.prompt)
        expect(item.verification).toHaveLength(1)
        expect(item.verification[0]).toMatchObject({
          name: 'behavior',
          command: 'node',
          timeoutSeconds: 30,
          required: true,
          expect: 'pass',
        })
        const [verifier] = item.verification
        if (!verifier)
          throw new Error(`Missing verifier for task: ${item.name}`)
        expect(verifier.args).toHaveLength(2)
        expect(verifier.args[0]).toBe('-e')
        expect(verifier.args[1]?.trim().length).toBeGreaterThan(0)
        expect(verifier.args[1]).toContain(
          `Object.hasOwn(m, '${contract.exportName}')`,
        )
        expect(verifier.args[1]).toContain(`m.${contract.exportName}`)
        expect(verifier.args[1]).not.toMatch(/\|\|\s*typeof/u)
        expect(item.execution.maxTurns).toBe(12)
        expect(item.execution.timeoutSeconds).toBe(180)
        expect(item.execution.allowedTools).toEqual([
          'Read',
          'Glob',
          'Grep',
          'Edit',
          'Write',
          'Bash',
        ])
        expect(item.execution.env).toEqual({})
        expect(item.expect.allowedChangedPaths).toEqual([
          target[repository.id as keyof typeof target],
        ])
        expect(item.expect.expectedChangedPaths).toEqual([
          target[repository.id as keyof typeof target],
        ])
        expect(item.expect.forbiddenChangedPaths).toEqual([
          'src/other.mjs',
          '.git/**',
          '.praxis/**',
          '.env',
          '**/.env',
          'secrets/**',
        ])
        expect(item.expect.forbiddenChangedPaths.length).toBeGreaterThan(0)
        expect(item.tags).toEqual([
          'held-out',
          'praxis-held-out-v4',
          repository.id,
        ])
        expect(
          item.tags.some((tag) =>
            [
              'tuning',
              'calibration',
              'baseline',
              'candidate',
              'admission',
            ].includes(tag),
          ),
        ).toBe(false)
      }
    }
  })

  it('keeps every pristine verifier unsolved', async () => {
    const corpus = await loadHeldOutCorpus(root)
    for (const repository of corpus.repositories)
      for (const item of repository.cases) {
        const [verifier] = item.verification
        if (!verifier)
          throw new Error(`Missing verifier for task: ${item.name}`)
        const result = verifierResult(
          verifier.command,
          verifier.args,
          item.fixture,
        )
        expect(result.signal).toBeNull()
        expect(result.status, `${item.name}: ${result.stderr}`).toBe(42)
      }
  })

  it('rejects present but non-functional target exports', async () => {
    const corpus = await loadHeldOutCorpus(root)
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'praxis-v4-wrong-'))
    try {
      for (const repository of corpus.repositories)
        for (const item of repository.cases) {
          const contract = requireTaskContract(item.name)
          const fixture = join(temporaryRoot, item.name.replaceAll('.', '-'))
          const modulePath = join(
            fixture,
            target[repository.id as keyof typeof target],
          )
          mkdirSync(dirname(modulePath), { recursive: true })
          writeFileSync(
            modulePath,
            `export const ${contract.exportName} = {}\n`,
          )
          const [verifier] = item.verification
          if (!verifier)
            throw new Error(`Missing verifier for task: ${item.name}`)
          const result = verifierResult(
            verifier.command,
            verifier.args,
            fixture,
          )
          expect(result.signal).toBeNull()
          expect(result.status, `${item.name}: ${result.stderr}`).toBe(1)
        }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true })
    }
  })
})
