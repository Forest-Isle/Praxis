import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { sanitizeClaudeProjectPath } from '../compatibility/claude/paths.js'
import {
  executeClaudeProjectPurge,
  planClaudeProjectPurge,
} from './claude-project-purge.js'

const roots: string[] = []
const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

async function writeFixture(path: string, content = 'fixture'): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function fixture(): Promise<{
  root: string
  configRoot: string
  statePath: string
  project: string
  otherProject: string
}> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'praxis-project-purge-')),
  )
  roots.push(root)
  const configRoot = join(root, 'config')
  const project = join(root, 'project')
  const otherProject = join(root, 'other-project')
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(otherProject, { recursive: true }),
  ])
  return {
    root,
    configRoot,
    statePath: join(configRoot, '.claude.json'),
    project,
    otherProject,
  }
}

async function missing(path: string): Promise<boolean> {
  try {
    await access(path)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('Claude project purge', () => {
  it('purges only target project state and preserves unknown shared state', async () => {
    const { configRoot, statePath, project, otherProject } = await fixture()
    const projectRoot = join(
      configRoot,
      'projects',
      sanitizeClaudeProjectPath(project),
    )
    const otherProjectRoot = join(
      configRoot,
      'projects',
      sanitizeClaudeProjectPath(otherProject),
    )
    const state = {
      theme: 'dark',
      unknown: { nested: true },
      projects: {
        [project]: { hasTrustDialogAccepted: true, custom: 'target' },
        [otherProject]: { hasTrustDialogAccepted: false, custom: 'keep' },
      },
    }
    const malformedHistoryLine = '{not-json}\n'
    await Promise.all([
      writeFixture(join(projectRoot, `${SESSION_A}.jsonl`), '{}\n'),
      writeFixture(
        join(projectRoot, SESSION_A, 'subagents', 'agent-one.jsonl'),
        '{}\n',
      ),
      writeFixture(join(projectRoot, 'memory', 'MEMORY.md'), 'remember'),
      writeFixture(join(otherProjectRoot, `${SESSION_B}.jsonl`), '{}\n'),
      writeFixture(join(configRoot, 'tasks', SESSION_A, '1.json'), '{}'),
      writeFixture(join(configRoot, 'tasks', SESSION_B, '1.json'), '{}'),
      writeFixture(join(configRoot, 'debug', `${SESSION_A}.txt`), 'target'),
      writeFixture(join(configRoot, 'debug', `${SESSION_B}.txt`), 'other'),
      writeFixture(
        join(configRoot, 'file-history', SESSION_A, 'backup'),
        'target',
      ),
      writeFixture(
        join(configRoot, 'file-history', SESSION_B, 'backup'),
        'other',
      ),
      writeFixture(statePath, JSON.stringify(state)),
      writeFixture(
        join(configRoot, 'history.jsonl'),
        [
          JSON.stringify({ display: 'remove', project }),
          JSON.stringify({ display: 'keep', project: otherProject }),
          malformedHistoryLine.trimEnd(),
        ].join('\n') + '\n',
      ),
      writeFixture(join(configRoot, 'shell-snapshots', 'keep.sh'), 'keep'),
      writeFixture(join(configRoot, 'backups', 'keep.json'), 'keep'),
      writeFixture(join(configRoot, 'praxis', 'keep.json'), 'keep'),
    ])

    const plan = await planClaudeProjectPurge({
      cwd: project,
      configRoot,
      statePath,
      homeDirectory: configRoot,
    })
    expect(plan.targetPath).toBe(project)
    expect(plan.projectIdentity).toBe(project)
    expect(plan.sessionIds).toEqual([SESSION_A])
    expect(plan.items.map((item) => item.kind)).toEqual([
      'tasks',
      'debug',
      'file-history',
      'project',
      'prompt-history',
      'config-key',
    ])

    await expect(
      executeClaudeProjectPurge(plan, { dryRun: true }),
    ).resolves.toMatchObject({ dryRun: true, deleted: [], failures: [] })
    await expect(access(projectRoot)).resolves.toBeUndefined()

    const result = await executeClaudeProjectPurge(plan)
    expect(result).toMatchObject({
      dryRun: false,
      aborted: false,
      skipped: [],
      failures: [],
    })
    expect(result.deleted).toHaveLength(6)
    await expect(missing(projectRoot)).resolves.toBe(true)
    await expect(missing(join(configRoot, 'tasks', SESSION_A))).resolves.toBe(
      true,
    )
    await expect(
      missing(join(configRoot, 'debug', `${SESSION_A}.txt`)),
    ).resolves.toBe(true)
    await expect(
      missing(join(configRoot, 'file-history', SESSION_A)),
    ).resolves.toBe(true)

    await Promise.all([
      access(otherProjectRoot),
      access(join(configRoot, 'tasks', SESSION_B)),
      access(join(configRoot, 'debug', `${SESSION_B}.txt`)),
      access(join(configRoot, 'file-history', SESSION_B)),
      access(join(configRoot, 'shell-snapshots', 'keep.sh')),
      access(join(configRoot, 'backups', 'keep.json')),
      access(join(configRoot, 'praxis', 'keep.json')),
    ])
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({
      theme: 'dark',
      unknown: { nested: true },
      projects: {
        [otherProject]: {
          hasTrustDialogAccepted: false,
          custom: 'keep',
        },
      },
    })
    expect(await readFile(join(configRoot, 'history.jsonl'), 'utf8')).toBe(
      `${JSON.stringify({ display: 'keep', project: otherProject })}\n${malformedHistoryLine}`,
    )
  })

  it('collects orphan session directories and supports per-item abort', async () => {
    const { configRoot, statePath, project } = await fixture()
    const projectRoot = join(
      configRoot,
      'projects',
      sanitizeClaudeProjectPath(project),
    )
    await Promise.all([
      writeFixture(join(projectRoot, SESSION_A, 'subagents', 'agent.jsonl')),
      writeFixture(join(configRoot, 'tasks', SESSION_A, '1.json')),
      writeFixture(join(configRoot, 'file-history', SESSION_A, 'backup')),
      writeFixture(statePath, JSON.stringify({ projects: {} })),
    ])
    const plan = await planClaudeProjectPurge({
      cwd: project,
      configRoot,
      statePath,
      homeDirectory: configRoot,
    })
    expect(plan.sessionIds).toEqual([SESSION_A])

    let selections = 0
    const result = await executeClaudeProjectPurge(plan, {
      selectItem: async () => {
        selections += 1
        return selections === 1 ? 'skip' : 'abort'
      },
    })
    expect(result.aborted).toBe(true)
    expect(result.skipped).toEqual([plan.items[0]])
    expect(result.deleted).toEqual([])
    await Promise.all([
      access(projectRoot),
      access(join(configRoot, 'tasks', SESSION_A)),
      access(join(configRoot, 'file-history', SESSION_A)),
    ])
  })

  it('includes Claude project directories for worktrees below the target project', async () => {
    const { configRoot, statePath, project } = await fixture()
    const worktree = join(project, '.worktrees', 'feature')
    const targetRoot = join(
      configRoot,
      'projects',
      sanitizeClaudeProjectPath(project),
    )
    const worktreeRoot = join(
      configRoot,
      'projects',
      sanitizeClaudeProjectPath(worktree),
    )
    await Promise.all([
      writeFixture(join(targetRoot, `${SESSION_A}.jsonl`)),
      writeFixture(join(worktreeRoot, `${SESSION_B}.jsonl`)),
      writeFixture(join(configRoot, 'tasks', SESSION_A, '1.json')),
      writeFixture(join(configRoot, 'tasks', SESSION_B, '1.json')),
      writeFixture(statePath, JSON.stringify({ projects: {} })),
    ])

    const plan = await planClaudeProjectPurge({
      cwd: project,
      configRoot,
      statePath,
    })
    expect(plan.projectRootPaths).toEqual([targetRoot, worktreeRoot])
    expect(plan.sessionIds).toEqual([SESSION_A, SESSION_B])
    expect(plan.items.filter((item) => item.kind === 'project')).toHaveLength(2)
    const result = await executeClaudeProjectPurge(plan)
    expect(result.failures).toEqual([])
    await Promise.all([
      expect(missing(targetRoot)).resolves.toBe(true),
      expect(missing(worktreeRoot)).resolves.toBe(true),
      expect(missing(join(configRoot, 'tasks', SESSION_A))).resolves.toBe(true),
      expect(missing(join(configRoot, 'tasks', SESSION_B))).resolves.toBe(true),
    ])
  })

  it('purges every shared project resource with --all and keeps other roots', async () => {
    const { configRoot, statePath, project, otherProject } = await fixture()
    await Promise.all([
      writeFixture(
        join(
          configRoot,
          'projects',
          sanitizeClaudeProjectPath(project),
          `${SESSION_A}.jsonl`,
        ),
      ),
      writeFixture(join(configRoot, 'tasks', SESSION_A, '1.json')),
      writeFixture(join(configRoot, 'debug', `${SESSION_A}.txt`)),
      writeFixture(join(configRoot, 'file-history', SESSION_A, 'backup')),
      writeFixture(join(configRoot, 'history.jsonl'), '{}\n'),
      writeFixture(join(configRoot, 'shell-snapshots', 'keep.sh')),
      writeFixture(join(configRoot, 'backups', 'keep.json')),
      writeFixture(join(configRoot, 'praxis', 'keep.json')),
      writeFixture(
        statePath,
        JSON.stringify({
          version: 7,
          custom: ['keep'],
          projects: { [project]: { one: 1 }, [otherProject]: { two: 2 } },
        }),
      ),
    ])

    const plan = await planClaudeProjectPurge({
      cwd: project,
      all: true,
      configRoot,
      statePath,
    })
    expect(plan.items.map((item) => item.kind)).toEqual([
      'project',
      'tasks',
      'debug',
      'file-history',
      'prompt-history',
      'config-key',
    ])
    expect(plan.items.at(-1)?.count).toBe(2)
    const result = await executeClaudeProjectPurge(plan)
    expect(result.failures).toEqual([])
    expect(result.deleted).toHaveLength(6)
    await Promise.all(
      ['projects', 'tasks', 'debug', 'file-history', 'history.jsonl'].map(
        async (name) =>
          expect(await missing(join(configRoot, name))).toBe(true),
      ),
    )
    await Promise.all([
      access(join(configRoot, 'shell-snapshots', 'keep.sh')),
      access(join(configRoot, 'backups', 'keep.json')),
      access(join(configRoot, 'praxis', 'keep.json')),
    ])
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({
      version: 7,
      custom: ['keep'],
      projects: {},
    })
  })

  it('rejects malformed state before deleting any project data', async () => {
    const { configRoot, statePath, project } = await fixture()
    const transcript = join(
      configRoot,
      'projects',
      sanitizeClaudeProjectPath(project),
      `${SESSION_A}.jsonl`,
    )
    await Promise.all([
      writeFixture(transcript),
      writeFixture(statePath, '{bad-json'),
    ])

    await expect(
      planClaudeProjectPurge({
        cwd: project,
        configRoot,
        statePath,
        homeDirectory: configRoot,
      }),
    ).rejects.toThrow(`Invalid Claude state JSON: ${statePath}`)
    await expect(access(transcript)).resolves.toBeUndefined()
  })

  it('rejects project roots that escape the config root through a symlink', async () => {
    const { root, configRoot, statePath, project } = await fixture()
    const outside = join(root, 'outside')
    const projectRoot = join(
      configRoot,
      'projects',
      sanitizeClaudeProjectPath(project),
    )
    await Promise.all([
      mkdir(dirname(projectRoot), { recursive: true }),
      writeFixture(join(outside, `${SESSION_A}.jsonl`)),
      writeFixture(statePath, JSON.stringify({ projects: {} })),
    ])
    await symlink(outside, projectRoot)

    await expect(
      planClaudeProjectPurge({
        cwd: project,
        configRoot,
        statePath,
        homeDirectory: configRoot,
      }),
    ).rejects.toThrow(`Refusing to purge symbolic link: ${projectRoot}`)
    await expect(
      access(join(outside, `${SESSION_A}.jsonl`)),
    ).resolves.toBeUndefined()
  })

  it('enforces --all path exclusivity and returns an empty plan for no state', async () => {
    const { configRoot, statePath, project } = await fixture()
    await expect(
      planClaudeProjectPurge({
        cwd: project,
        path: project,
        all: true,
        configRoot,
        statePath,
      }),
    ).rejects.toThrow('Cannot specify both a path and --all')

    await expect(
      planClaudeProjectPurge({
        cwd: project,
        configRoot,
        statePath,
        homeDirectory: configRoot,
      }),
    ).resolves.toMatchObject({ items: [], sessionIds: [] })
  })

  it('uses Claude state path beside an explicitly configured config root', async () => {
    const { configRoot, project } = await fixture()
    await expect(
      planClaudeProjectPurge({ cwd: project, configRoot }),
    ).resolves.toMatchObject({
      statePath: join(configRoot, '.claude.json'),
      items: [],
    })
  })
})
