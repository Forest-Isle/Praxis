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

const corpus = join(
  process.cwd(),
  'test/corpora/project-evals/praxis-held-out-v1',
)
const temporaryRoots: string[] = []

async function copyCorpus(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-held-out-'))
  temporaryRoots.push(root)
  const destination = join(root, 'corpus')
  await cp(corpus, destination, { recursive: true })
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
})

describe('held-out corpus contract', () => {
  it('loads three versioned repositories and twelve three-repeat tasks without executing them', async () => {
    const loaded = await loadHeldOutCorpus(corpus)
    expect(loaded).toMatchObject({
      schemaVersion: '1.0',
      id: 'praxis-held-out-v1',
      version: 1,
      split: 'held-out',
      repetitions: 3,
      taskCount: 12,
      plannedRunCount: 36,
      policy: {
        execution: 'opt-in-only',
        tuning: 'forbidden',
        resultInformedChanges: 'require-new-version',
      },
    })
    expect(loaded.repositories).toHaveLength(3)
    const manifest = parseYaml(
      await readFile(join(corpus, 'corpus.yaml'), 'utf8'),
    ) as { repositories: { id: string; tasks: string[] }[] }
    for (const repository of loaded.repositories) {
      const declaration = manifest.repositories.find(
        (item) => item.id === repository.id,
      )
      expect(repository.cases.map((item) => item.name)).toEqual(
        declaration?.tasks,
      )
    }
    expect(
      loaded.repositories.flatMap((repository) => repository.cases),
    ).toHaveLength(12)
    expect(
      new Set(
        loaded.repositories.flatMap((repository) =>
          repository.cases.map((item) => item.name),
        ),
      ).size,
    ).toBe(12)
  })

  it('rejects unsafe, incomplete, contaminated, and content-drifted corpora', async () => {
    const expectFailure = async (
      mutate: (root: string) => Promise<void>,
      message: string,
    ) => {
      const root = await copyCorpus()
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
  }, 30_000)
})
