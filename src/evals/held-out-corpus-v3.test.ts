import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { loadHeldOutCorpus } from './held-out-corpus.js'

const ROOT = fileURLToPath(
  new URL(
    '../../test/corpora/project-evals/praxis-held-out-v3',
    import.meta.url,
  ),
)
const EXPECTED_DIGEST =
  'sha256:9380f5ccd9b920bf9767381f2d36d91dc04abe645db0a7c1a5f1597279d579ff'
const EXPECTED_REPOSITORIES = [
  [
    'frame-codec',
    [
      'frame-codec.add-encode-frame',
      'frame-codec.copy-decoded-payload',
      'frame-codec.reject-invalid-length',
      'frame-codec.stream-partial-frames',
    ],
  ],
  [
    'graph-craft',
    [
      'graph-craft.add-affected-targets',
      'graph-craft.detect-cycle',
      'graph-craft.reject-unknown-dependency',
      'graph-craft.stable-topological-order',
    ],
  ],
  [
    'route-forge',
    [
      'route-forge.add-terminal-splat',
      'route-forge.decode-parameters',
      'route-forge.fix-static-precedence',
      'route-forge.match-request-target',
    ],
  ],
] as const
const EXPECTED_TARGETS: Readonly<Record<string, string>> = {
  'frame-codec.add-encode-frame': 'src/frame.mjs',
  'frame-codec.copy-decoded-payload': 'src/frame.mjs',
  'frame-codec.reject-invalid-length': 'src/frame.mjs',
  'frame-codec.stream-partial-frames': 'src/stream.mjs',
  'graph-craft.add-affected-targets': 'src/graph.mjs',
  'graph-craft.detect-cycle': 'src/graph.mjs',
  'graph-craft.reject-unknown-dependency': 'src/graph.mjs',
  'graph-craft.stable-topological-order': 'src/graph.mjs',
  'route-forge.add-terminal-splat': 'src/router.mjs',
  'route-forge.decode-parameters': 'src/router.mjs',
  'route-forge.fix-static-precedence': 'src/router.mjs',
  'route-forge.match-request-target': 'src/index.mjs',
}

describe('praxis-held-out-v3 corpus contract', () => {
  it('freezes identity, integrity, and intentionally unsolved verifiers', async () => {
    const corpus = await loadHeldOutCorpus(ROOT)
    expect({
      id: corpus.id,
      version: corpus.version,
      split: corpus.split,
      repetitions: corpus.repetitions,
      policy: corpus.policy,
      taskCount: corpus.taskCount,
      plannedRunCount: corpus.plannedRunCount,
    }).toEqual({
      id: 'praxis-held-out-v3',
      version: 3,
      split: 'held-out',
      repetitions: 3,
      policy: {
        execution: 'opt-in-only',
        tuning: 'forbidden',
        resultInformedChanges: 'require-new-version',
      },
      taskCount: 12,
      plannedRunCount: 36,
    })
    expect(corpus.contentSha256).toBe(EXPECTED_DIGEST)
    expect(corpus.repositories.map(({ id, tasks }) => [id, tasks])).toEqual(
      EXPECTED_REPOSITORIES,
    )
    for (const repository of corpus.repositories) {
      expect(repository.cases).toHaveLength(4)
      for (const item of repository.cases) {
        expect(item.runs).toBe(3)
        expect(item.execution.model).toBeUndefined()
        expect(item.verification).toHaveLength(1)
        const [verifier] = item.verification
        if (!verifier) throw new Error('Held-out verifier invariant violated')
        expect(verifier.required).toBe(true)
        expect(verifier.expect).toBe('pass')
        expect(item.expect.allowedChangedPaths).toHaveLength(1)
        expect(item.expect.allowedChangedPaths).toEqual([
          EXPECTED_TARGETS[item.name],
        ])
        expect(item.expect.expectedChangedPaths).toEqual(
          item.expect.allowedChangedPaths,
        )
        expect(item.expect.forbiddenChangedPaths.length).toBeGreaterThan(0)
        expect(item.tags).toEqual(
          expect.arrayContaining([
            'held-out',
            'praxis-held-out-v3',
            repository.id,
          ]),
        )
        for (const forbiddenTag of [
          'tuning',
          'calibration',
          'baseline',
          'candidate',
          'admission',
        ]) {
          expect(item.tags).not.toContain(forbiddenTag)
        }
        const result = spawnSync(verifier.command, [...verifier.args], {
          cwd: item.fixture,
          env: {
            PATH: process.env.PATH ?? '',
            NODE_PATH: process.env.NODE_PATH ?? '',
          },
          timeout: verifier.timeoutSeconds * 1000,
          encoding: 'utf8',
        })
        expect(result.signal).toBeNull()
        expect(result.status).toBe(42)
      }
    }
  })
})
