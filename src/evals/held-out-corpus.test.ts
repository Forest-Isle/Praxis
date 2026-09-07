import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { loadHeldOutCorpus } from './held-out-corpus.js'

const corpusV1 = join(
  process.cwd(),
  'test/corpora/project-evals/praxis-held-out-v1',
)
const corpusV1Digest =
  'sha256:47dfad705f94463ce885e06a61601724be309f9d423241a4df91afde1503ccdb'
const corpusV2 = join(
  process.cwd(),
  'test/corpora/project-evals/praxis-held-out-v2',
)
const corpusV2Digest =
  'sha256:1ae6e3485684db143ead1983479500f7fb80d13fd99769d8e202d4c7c35881b3'
const temporaryRoots: string[] = []

async function copyCorpus(source = corpusV1): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-held-out-'))
  temporaryRoots.push(root)
  const destination = join(root, 'corpus')
  await cp(source, destination, { recursive: true })
  return destination
}

async function mutateManifest(
  root: string,
  mutate: (manifest: string) => string,
): Promise<void> {
  const path = join(root, 'corpus.yaml')
  await writeFile(path, mutate(await readFile(path, 'utf8')))
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  )
}, 30_000)

describe('held-out corpus contract', () => {
  it('loads immutable v1 and v2 corpora without executing them', async () => {
    for (const expected of [
      {
        root: corpusV1,
        id: 'praxis-held-out-v1',
        version: 1,
        digest: corpusV1Digest,
      },
      {
        root: corpusV2,
        id: 'praxis-held-out-v2',
        version: 2,
        digest: corpusV2Digest,
      },
    ] as const) {
      const loaded = await loadHeldOutCorpus(expected.root)
      expect(loaded).toMatchObject({
        schemaVersion: '1.0',
        id: expected.id,
        version: expected.version,
        split: 'held-out',
        repetitions: 3,
        taskCount: 12,
        plannedRunCount: 36,
        contentSha256: expected.digest,
        policy: {
          execution: 'opt-in-only',
          tuning: 'forbidden',
          resultInformedChanges: 'require-new-version',
        },
      })
      expect(loaded.repositories).toHaveLength(3)
      const manifest = parseYaml(
        await readFile(join(expected.root, 'corpus.yaml'), 'utf8'),
      ) as { repositories: { id: string; tasks: string[] }[] }
      const repositoryIds = loaded.repositories.map((item) => item.id)
      expect(repositoryIds).toEqual(
        manifest.repositories.map((item) => item.id),
      )
      expect(repositoryIds).toEqual([...repositoryIds].sort())
      const discoveredTasks = loaded.repositories.flatMap((repository) => {
        const names = repository.cases.map((item) => item.name)
        const declaration = manifest.repositories.find(
          (item) => item.id === repository.id,
        )
        expect(names).toEqual(declaration?.tasks)
        expect(names).toEqual([...names].sort())
        return names
      })
      expect(discoveredTasks).toHaveLength(12)
      expect(new Set(discoveredTasks).size).toBe(12)
      expect(discoveredTasks).toEqual([...discoveredTasks].sort())
    }
  })

  it('rejects unsafe, incomplete, contaminated, version-mismatched, and content-drifted corpora', async () => {
    const expectFailure = async (
      mutate: (root: string) => Promise<void>,
      message: string,
      source = corpusV1,
    ) => {
      const root = await copyCorpus(source)
      await mutate(root)
      await expect(loadHeldOutCorpus(root)).rejects.toThrow(message)
    }
    const mutateCase = async (
      root: string,
      path: string,
      mutate: (content: string) => string,
    ) => {
      const file = join(root, path)
      await writeFile(file, mutate(await readFile(file, 'utf8')))
    }
    await expectFailure(
      (root) =>
        mutateManifest(root, (manifest) =>
          manifest.replace('version: 1', 'version: 2'),
        ),
      'Unsupported corpus version',
    )
    await expectFailure(
      (root) =>
        mutateManifest(root, (manifest) =>
          manifest.replace('version: 2', 'version: 3'),
        ),
      'Corpus id and version do not match',
      corpusV2,
    )
    await expectFailure(
      (root) =>
        mutateManifest(root, (manifest) =>
          manifest.replace('version: 2', 'version: 9007199254740992'),
        ),
      'Unsupported corpus version',
      corpusV2,
    )
    await expectFailure(
      (root) =>
        mutateCase(
          root,
          'repositories/header-map/evals/case-insensitive-get/case.yaml',
          (content) =>
            content.replace('praxis-held-out-v2', 'praxis-held-out-v1'),
        ),
      'missing required held-out tags',
      corpusV2,
    )
    await expectFailure(
      (root) =>
        mutateManifest(root, (manifest) =>
          manifest.replace(
            'path: repositories/config-kit',
            'path: ../config-kit',
          ),
        ),
      'contained relative path',
    )
    await expectFailure(
      async (root) =>
        symlink(
          join(root, 'repositories/string-kit'),
          join(root, 'repositories/config-kit/linked'),
        ),
      'contains symlink',
    )
    const specialRoot = await copyCorpus()
    const specialPath = join(
      specialRoot,
      'repositories/config-kit/special.sock',
    )
    const socketRoot = await mkdtemp(join(tmpdir(), 'praxis-heldout-socket-'))
    temporaryRoots.push(socketRoot)
    const socketPath = join(socketRoot, 'special.sock')
    const server = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, () => resolve())
      })
      await rename(socketPath, specialPath)
      await expect(loadHeldOutCorpus(specialRoot)).rejects.toThrow(
        'unsupported entry',
      )
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    await expectFailure(
      async (root) => mkdir(join(root, 'repositories/config-kit/.git')),
      'forbidden entry',
    )
    await expectFailure(
      async (root) => mkdir(join(root, 'repositories/config-kit/node_modules')),
      'forbidden entry',
    )
    await expectFailure(async (root) => {
      await writeFile(
        join(root, 'repositories/config-kit/evals/add-json-output/case.yaml'),
        'invalid: [yaml',
      )
      const overflow = join(root, 'repositories/config-kit/file-overflow')
      await mkdir(overflow)
      for (let start = 0; start < 4_097; start += 256) {
        const count = Math.min(256, 4_097 - start)
        await Promise.all(
          Array.from({ length: count }, (_, offset) =>
            writeFile(join(overflow, `file-${start + offset}`), ''),
          ),
        )
      }
    }, 'file limit')
    await expectFailure(async (root) => {
      const oversized = join(root, 'repositories/config-kit/oversized.bin')
      await writeFile(oversized, '')
      await truncate(oversized, 64 * 1024 * 1024 + 1)
    }, 'byte limit')
    await expectFailure(
      (root) =>
        mutateManifest(root, (manifest) =>
          manifest.replace(
            'path: repositories/task-store',
            'path: repositories/string-kit',
          ),
        ),
      'roots must be unique and non-nested',
    )
    await expectFailure(
      (root) =>
        mutateManifest(root, (manifest) =>
          manifest.replace(
            'path: repositories/task-store',
            'path: repositories/string-kit/evals',
          ),
        ),
      'roots must be unique and non-nested',
    )
    await expectFailure(
      (root) =>
        mutateManifest(root, (manifest) =>
          manifest.replace(/\n\s{2}- id: task-store[\s\S]*$/u, ''),
        ),
      'at least three repositories',
    )
    await expectFailure(
      (root) =>
        mutateManifest(root, (manifest) =>
          manifest.replace('      - config-kit.validate-port-range', ''),
        ),
      'at least four task names',
    )
    await expectFailure(
      (root) =>
        mutateManifest(root, (manifest) =>
          manifest.replace(
            '      - task-store.stable-priority-order',
            '      - task-store.zzz',
          ),
        ),
      'does not match discovery',
    )
    await expectFailure(
      (root) =>
        mutateManifest(root, (manifest) =>
          manifest.replace('repetitions: 3', 'repetitions: 2'),
        ),
      'repetitions must be 3',
    )
    const caseRoot = 'repositories/config-kit/evals/add-json-output/case.yaml'
    await expectFailure(
      (root) =>
        mutateCase(root, caseRoot, (content) =>
          content.replace('runs: 3', 'runs: 2'),
        ),
      'three repetitions',
    )
    const slugCase = 'repositories/string-kit/evals/fix-slug-collapse/case.yaml'
    await expectFailure(
      (root) =>
        mutateCase(root, slugCase, (content) =>
          content.replace(
            'tags: [held-out, praxis-held-out-v1, string-kit]',
            'tags: [held-out, praxis-held-out-v1]',
          ),
        ),
      'missing required held-out tags',
    )
    await expectFailure(
      (root) =>
        mutateCase(root, slugCase, (content) =>
          content.replace(
            'tags: [held-out, praxis-held-out-v1, string-kit]',
            'tags: [held-out, praxis-held-out-v1, string-kit, tuning]',
          ),
        ),
      'forbidden tuning tag',
    )
    await expectFailure(
      (root) =>
        mutateCase(root, slugCase, (content) =>
          content.replace('  env: {}', '  model: pinned\n  env: {}'),
        ),
      'must not pin a model',
    )
    await expectFailure(
      (root) =>
        mutateCase(root, slugCase, (content) =>
          content.replace(
            /verification:[\s\S]*?graders:/u,
            'verification: []\ngraders:',
          ),
        ),
      'required verifier',
    )
    await expectFailure(
      (root) =>
        mutateCase(root, slugCase, (content) =>
          content.replace(
            'allowed_changed_paths: [src/slug.cjs]',
            'allowed_changed_paths: []',
          ),
        ),
      'allowed, expected, and forbidden mutations',
    )
    await expectFailure(
      (root) =>
        mutateCase(root, slugCase, (content) =>
          content.replace(/forbidden_changed_paths:[\s\S]*$/u, ''),
        ),
      'allowed, expected, and forbidden mutations',
    )
    await expectFailure(
      (root) =>
        mutateCase(root, slugCase, (content) =>
          content.replace(
            'expected_changed_paths: [src/slug.cjs]',
            'expected_changed_paths: [src/index.cjs]',
          ),
        ),
      'expected mutations must be allowed',
    )
    await expectFailure(
      (root) =>
        mutateCase(root, slugCase, (content) =>
          content.replace(
            /forbidden_changed_paths:[\s\S]*$/u,
            'forbidden_changed_paths: [src/slug.cjs]',
          ),
        ),
      'mutation paths overlap',
    )
    await expectFailure(
      (root) =>
        mutateCase(root, slugCase, (content) =>
          content
            .replace(
              'allowed_changed_paths: [src/slug.cjs]',
              'allowed_changed_paths: [src/*.cjs]',
            )
            .replace(
              'expected_changed_paths: [src/slug.cjs]',
              'expected_changed_paths: [src/*.cjs]',
            ),
        ),
      'allowed and expected mutations must use exact paths',
    )
    await expectFailure(
      (root) =>
        mutateCase(root, slugCase, (content) =>
          content.replace(
            /forbidden_changed_paths:[\s\S]*$/u,
            'forbidden_changed_paths: [src/*.cjs]',
          ),
        ),
      'mutation paths overlap',
    )
    await expectFailure(async (root) => {
      const overflow = join(root, 'repositories/config-kit/overflow')
      await mkdir(overflow)
      for (let start = 0; start < 16_384; start += 256)
        await Promise.all(
          Array.from({ length: 256 }, (_, offset) =>
            mkdir(join(overflow, `entry-${start + offset}`)),
          ),
        )
    }, 'directory entry limit')
    await expectFailure(
      (root) =>
        writeFile(
          join(
            root,
            'repositories/config-kit/evals/add-json-output/fixture/src/config.cjs',
          ),
          'changed\n',
        ),
      'content digest mismatch',
    )
  }, 90_000)
})
