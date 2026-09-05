import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  assertProjectEvalIdentitiesComparable,
  computeProjectEvalAggregateIdentity,
  createProjectEvalIdentity,
  firstProjectEvalIdentityMismatch,
  validateProjectEvalIdentity,
  validateProjectEvalAggregateIdentity,
} from './project-eval-identity.js'
import type { ProjectEvalCase } from './project-eval-schema.js'

const TEST_BUILD_IDENTITY = {
  schema_version: '1.0' as const,
  source_revision: ('git:' + 'a'.repeat(40)) as `git:${string}`,
  source_dirty: false,
  artifact_sha256: `sha256:${'b'.repeat(64)}` as `sha256:${string}`,
}

function makeCase(overrides: Partial<ProjectEvalCase> = {}): ProjectEvalCase {
  return {
    schemaVersion: '1.0',
    name: 'identity-case',
    dir: '/absolute/case',
    fixture: '/absolute/case/fixture',
    tags: [],
    runs: 1,
    execution: {
      prompt: 'Do the work.',
      maxTurns: 5,
      timeoutSeconds: 30,
      allowedTools: ['Read'],
      env: { EVAL_MARKER: 'one' },
    },
    verification: [],
    graders: [],
    expect: {
      allowedChangedPaths: ['result.txt'],
      expectedChangedPaths: ['result.txt'],
      forbiddenChangedPaths: ['.env'],
    },
    ...overrides,
  }
}

function makeIdentity(
  changes: Partial<Parameters<typeof createProjectEvalIdentity>[0]> = {},
) {
  return createProjectEvalIdentity({
    provider: {
      providerId: 'openai',
      profileId: 'default',
      protocol: 'openai-compatible',
      endpoint: 'https://secret.example/v1',
      modelId: 'model-a',
    },
    case: makeCase(),
    sourceBefore: {
      files: {
        'src/a.ts': { hash: 'a'.repeat(64), size: 1, mode: 0o644 },
      },
      totalBytes: 1,
    },
    effectiveTools: ['Read'],
    runVerification: false,
    buildIdentity: TEST_BUILD_IDENTITY,
    praxisVersion: '0.1.0',
    nodeVersion: 'node-test',
    platform: 'test-platform',
    architecture: 'test-arch',
    ...changes,
  })
}

describe('project eval identity', () => {
  it('is deterministic, immutable, and independent of paths and object key order', () => {
    const left = makeIdentity()
    const right = makeIdentity({
      case: makeCase({
        dir: '/another/root',
        fixture: '/another/root/fixture',
      }),
      sourceBefore: {
        totalBytes: 1,
        files: {
          'src/a.ts': { mode: 0o644, size: 1, hash: 'a'.repeat(64) },
        },
      },
    })
    expect(right).toEqual(left)
    expect(Object.isFrozen(left)).toBe(true)
    expect(JSON.stringify(left)).not.toContain('secret.example')
    expect(JSON.stringify(left)).not.toContain('Do the work.')
    expect(JSON.stringify(left)).not.toContain('EVAL_MARKER')
    expect(JSON.stringify(left)).not.toContain('/absolute')
    expect(
      validateProjectEvalIdentity(JSON.parse(JSON.stringify(left))),
    ).toEqual(left)
  })

  it('uses explicit code-unit ordering for integer-like and Unicode keys', () => {
    const hash = 'a'.repeat(64)
    const identity = makeIdentity({
      sourceBefore: {
        files: {
          '10': { hash, size: 1, mode: 0o644 },
          '2': { hash, size: 1, mode: 0o644 },
          A: { hash, size: 1, mode: 0o644 },
          a: { hash, size: 1, mode: 0o644 },
          é: { hash, size: 1, mode: 0o644 },
        },
        totalBytes: 5,
      },
    })
    const canonicalCorpus =
      `{"files":{"10":{"hash":"${hash}","mode":420,"size":1},` +
      `"2":{"hash":"${hash}","mode":420,"size":1},` +
      `"A":{"hash":"${hash}","mode":420,"size":1},` +
      `"a":{"hash":"${hash}","mode":420,"size":1},` +
      `"é":{"hash":"${hash}","mode":420,"size":1}},"total_bytes":5}`
    const expected = createHash('sha256')
      .update(canonicalCorpus, 'utf8')
      .digest('hex')
    expect(identity.corpus_sha256).toBe(`sha256:${expected}`)
    expect(identity.endpoint_sha256).toBe(
      `sha256:${createHash('sha256')
        .update(JSON.stringify('https://secret.example/v1'), 'utf8')
        .digest('hex')}`,
    )
  })

  it('changes the relevant digest when semantic inputs change', () => {
    const base = makeIdentity()
    const variations = [
      [
        'provider',
        makeIdentity({ provider: { ...baseProvider(), providerId: 'relay' } }),
        'provider_id',
      ],
      [
        'profile',
        makeIdentity({ provider: { ...baseProvider(), profileId: 'other' } }),
        'profile_id',
      ],
      [
        'protocol',
        makeIdentity({
          provider: { ...baseProvider(), protocol: 'anthropic-messages' },
        }),
        'protocol',
      ],
      [
        'endpoint',
        makeIdentity({
          provider: { ...baseProvider(), endpoint: 'https://other.example/v1' },
        }),
        'endpoint_sha256',
      ],
      [
        'model',
        makeIdentity({ provider: { ...baseProvider(), modelId: 'model-b' } }),
        'model_id',
      ],
      [
        'execution',
        makeIdentity({
          case: makeCase({
            execution: { ...makeCase().execution, maxTurns: 6 },
          }),
        }),
        'configuration_sha256',
      ],
      [
        'verifier',
        makeIdentity({
          case: makeCase({
            verification: [
              {
                name: 'check',
                command: 'node',
                args: ['check.js'],
                timeoutSeconds: 1,
              },
            ],
          }),
        }),
        'configuration_sha256',
      ],
      [
        'grader',
        makeIdentity({
          case: makeCase({
            graders: [
              {
                type: 'regex',
                name: 'answer',
                weight: 1,
                target: 'last_message',
                pattern: 'yes',
                flags: '',
                match: 'contains',
              },
            ],
          }),
        }),
        'configuration_sha256',
      ],
      [
        'expectation',
        makeIdentity({
          case: makeCase({
            expect: {
              ...makeCase().expect,
              expectedChangedPaths: ['other.txt'],
            },
          }),
        }),
        'configuration_sha256',
      ],
      [
        'tools',
        makeIdentity({ effectiveTools: ['Glob', 'Read'] }),
        'tools_sha256',
      ],
      [
        'prompt',
        makeIdentity({
          case: makeCase({
            execution: { ...makeCase().execution, prompt: 'Other work.' },
          }),
        }),
        'prompt_sha256',
      ],
      [
        'system prompt',
        makeIdentity({
          case: makeCase({
            execution: {
              ...makeCase().execution,
              appendSystemPrompt: 'Extra.',
            },
          }),
        }),
        'prompt_sha256',
      ],
      [
        'corpus path',
        makeIdentity({
          sourceBefore: {
            files: {
              'src/b.ts': { hash: 'a'.repeat(64), size: 1, mode: 0o644 },
            },
            totalBytes: 1,
          },
        }),
        'corpus_sha256',
      ],
      [
        'corpus hash',
        makeIdentity({
          sourceBefore: {
            files: {
              'src/a.ts': { hash: 'b'.repeat(64), size: 1, mode: 0o644 },
            },
            totalBytes: 1,
          },
        }),
        'corpus_sha256',
      ],
      [
        'corpus size',
        makeIdentity({
          sourceBefore: {
            files: {
              'src/a.ts': { hash: 'a'.repeat(64), size: 2, mode: 0o644 },
            },
            totalBytes: 2,
          },
        }),
        'corpus_sha256',
      ],
      [
        'corpus mode',
        makeIdentity({
          sourceBefore: {
            files: {
              'src/a.ts': { hash: 'a'.repeat(64), size: 1, mode: 0o755 },
            },
            totalBytes: 1,
          },
        }),
        'corpus_sha256',
      ],
      [
        'Praxis version',
        makeIdentity({ praxisVersion: '0.2.0' }),
        'runtime.runtime_sha256',
      ],
      [
        'source revision',
        makeIdentity({
          buildIdentity: {
            ...TEST_BUILD_IDENTITY,
            source_revision: `git:${'c'.repeat(40)}`,
          },
        }),
        'runtime.runtime_sha256',
      ],
      [
        'source dirty state',
        makeIdentity({
          buildIdentity: { ...TEST_BUILD_IDENTITY, source_dirty: true },
        }),
        'runtime.runtime_sha256',
      ],
      [
        'emitted artifact',
        makeIdentity({
          buildIdentity: {
            ...TEST_BUILD_IDENTITY,
            artifact_sha256: `sha256:${'d'.repeat(64)}`,
          },
        }),
        'runtime.runtime_sha256',
      ],
      [
        'Node version',
        makeIdentity({ nodeVersion: 'node-other' }),
        'runtime.runtime_sha256',
      ],
      [
        'platform',
        makeIdentity({ platform: 'other-platform' }),
        'runtime.runtime_sha256',
      ],
      [
        'architecture',
        makeIdentity({ architecture: 'other-arch' }),
        'runtime.runtime_sha256',
      ],
    ] as const
    for (const [, variation, dimension] of variations) {
      const read = (identity: ReturnType<typeof makeIdentity>): unknown =>
        dimension.startsWith('runtime.')
          ? identity.runtime[
              dimension.slice(
                'runtime.'.length,
              ) as keyof typeof identity.runtime
            ]
          : identity[dimension as keyof typeof identity]
      expect(read(variation)).not.toBe(read(base))
    }
  })

  it('normalizes absolute roots independently of platform and path spelling', () => {
    const first = makeIdentity({
      case: makeCase({
        dir: '/one/case',
        fixture: '/one/case/fixture',
        execution: {
          ...makeCase().execution,
          env: { EVAL_MARKER: 'ordinary' },
        },
        verification: [
          {
            name: 'check',
            command: '/one/root/check-secret-one',
            args: ['C:\\one\\root\\value'],
            timeoutSeconds: 1,
          },
        ],
      }),
    })
    const second = makeIdentity({
      case: makeCase({
        dir: 'C:\\two\\case',
        fixture: 'C:\\two\\case\\fixture',
        execution: {
          ...makeCase().execution,
          env: { EVAL_MARKER: 'ordinary' },
        },
        verification: [
          {
            name: 'check',
            command: 'C:\\two\\root\\check-value',
            args: ['/two/root/value'],
            timeoutSeconds: 1,
          },
        ],
      }),
    })
    expect(first.configuration_sha256).toBe(second.configuration_sha256)
  })

  it('redacts sensitive explicit values, including repetitions in verifier data', () => {
    const first = makeIdentity({
      case: makeCase({
        execution: {
          ...makeCase().execution,
          env: { EVAL_TOKEN: 'secret-one', EVAL_MARKER: 'ordinary' },
        },
        verification: [
          {
            name: 'check',
            command: 'check-secret-one',
            args: ['secret-one'],
            timeoutSeconds: 1,
          },
        ],
      }),
    })
    const second = makeIdentity({
      case: makeCase({
        execution: {
          ...makeCase().execution,
          env: { EVAL_TOKEN: 'secret-two', EVAL_MARKER: 'ordinary' },
        },
        verification: [
          {
            name: 'check',
            command: 'check-secret-two',
            args: ['secret-two'],
            timeoutSeconds: 1,
          },
        ],
      }),
    })
    expect(first.configuration_sha256).toBe(second.configuration_sha256)
    expect(JSON.stringify(first)).not.toContain('secret-one')
    expect(JSON.stringify(second)).not.toContain('secret-two')
  })

  it('keeps ordinary explicit environment values fingerprinted', () => {
    const first = makeIdentity({
      case: makeCase({
        execution: {
          ...makeCase().execution,
          env: { EVAL_MARKER: 'ordinary-one' },
        },
      }),
    })
    expect(
      makeIdentity({
        case: makeCase({
          execution: {
            ...makeCase().execution,
            env: { EVAL_MARKER: 'ordinary-two' },
          },
        }),
      }).configuration_sha256,
    ).not.toBe(first.configuration_sha256)
  })

  it('supports legal corpus and aggregate capacity and rejects tampering', () => {
    const corpusFiles: Record<
      string,
      { hash: string; size: number; mode: number }
    > = {}
    for (let index = 0; index < 10_000; index += 1)
      corpusFiles[`file-${index}.txt`] = {
        hash: 'a'.repeat(64),
        size: 1,
        mode: 0o644,
      }
    expect(
      makeIdentity({
        sourceBefore: { files: corpusFiles, totalBytes: 10_000 },
      }),
    ).toBeDefined()
    const identity = makeIdentity()
    const runs = Array.from({ length: 100_000 }, (_, index) => ({
      case: `case-${index}`,
      run: 1,
      identity_sha256: identity.identity_sha256,
    }))
    const aggregateDigest = computeProjectEvalAggregateIdentity(runs)
    expect(validateProjectEvalAggregateIdentity(aggregateDigest, runs)).toBe(
      aggregateDigest,
    )
    expect(() =>
      validateProjectEvalIdentity({ ...identity, schema_version: '0.9' }),
    ).toThrow('schema_version')
    expect(() =>
      makeIdentity({
        buildIdentity: {
          ...TEST_BUILD_IDENTITY,
          artifact_sha256: 'sha256:invalid',
        },
      }),
    ).toThrow('Invalid Praxis build identity')
    expect(() =>
      validateProjectEvalIdentity({
        ...identity,
        runtime: {
          ...identity.runtime,
          runtime_sha256: `sha256:${'0'.repeat(64)}`,
        },
      }),
    ).toThrow('runtime_sha256')
    expect(() =>
      validateProjectEvalIdentity({
        ...identity,
        identity_sha256: `sha256:${'0'.repeat(64)}`,
      }),
    ).toThrow('identity_sha256')
    expect(() =>
      validateProjectEvalAggregateIdentity(`sha256:${'0'.repeat(64)}`, runs),
    ).toThrow('aggregate identity_sha256')
  })

  it('binds aggregate identities independently of run order and validates mismatches', () => {
    const first = makeIdentity()
    const second = makeIdentity({ case: makeCase({ name: 'second-case' }) })
    const entries = [
      { case: 'first', run: 1, identity_sha256: first.identity_sha256 },
      { case: 'second', run: 1, identity_sha256: second.identity_sha256 },
    ] as const
    expect(computeProjectEvalAggregateIdentity(entries)).toBe(
      computeProjectEvalAggregateIdentity([...entries].reverse()),
    )
    expect(
      firstProjectEvalIdentityMismatch(
        first,
        makeIdentity({
          provider: { ...baseProvider(), providerId: 'anthropic' },
        }),
      ),
    ).toBe('provider_id')
    expect(() =>
      assertProjectEvalIdentitiesComparable(
        first,
        makeIdentity({
          provider: { ...baseProvider(), providerId: 'anthropic' },
        }),
      ),
    ).toThrow('provider_id')
  })
})

function baseProvider() {
  return {
    providerId: 'openai',
    profileId: 'default',
    protocol: 'openai-compatible',
    endpoint: 'https://secret.example/v1',
    modelId: 'model-a',
  }
}
