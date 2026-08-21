import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { sanitizeClaudeProjectPath } from './compatibility/claude/paths.js'
import { run } from './cli.js'

const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('project purge CLI', () => {
  it('preserves leading purge-all dry-run flags and leading help', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-purge-prefix-'))
    roots.push(root)
    const praxisRoot = join(root, 'praxis')
    const session = join(
      praxisRoot,
      'sessions',
      'project',
      `${SESSION_ID}.jsonl`,
    )
    await mkdir(join(praxisRoot, 'sessions', 'project'), { recursive: true })
    await writeFile(session, '{}\n')
    vi.stubEnv('PRAXIS_HOME', praxisRoot)
    let stdout = ''
    await expect(
      run(['--all', '--dry-run', '--json', 'project', 'purge'], {
        stdout: (message) => {
          stdout += message.toString()
        },
        stderr: () => undefined,
      }),
    ).resolves.toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ result: { dryRun: true } })
    await expect(readFile(session, 'utf8')).resolves.toBe('{}\n')

    stdout = ''
    await expect(
      run(['--help', 'project', 'purge'], {
        stdout: (message) => {
          stdout += message.toString()
        },
        stderr: () => undefined,
      }),
    ).resolves.toBe(0)
    expect(stdout).toContain('Usage: praxis project purge')
  })

  it('supports dry-run JSON and --yes without constructing a model service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-purge-cli-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const project = join(root, 'project')
    const projectRoot = join(
      configRoot,
      'projects',
      sanitizeClaudeProjectPath(project),
    )
    await mkdir(join(projectRoot, SESSION_ID), { recursive: true })
    await mkdir(configRoot, { recursive: true })
    await mkdir(project, { recursive: true })
    await writeFile(
      join(configRoot, '.claude.json'),
      JSON.stringify({ projects: { [project]: { keep: true } } }),
    )
    await mkdir(join(configRoot, 'tasks', SESSION_ID), { recursive: true })
    await writeFile(join(configRoot, 'tasks', SESSION_ID, 'task.json'), '{}')
    vi.stubEnv('CLAUDE_CONFIG_DIR', configRoot)
    let stdout = ''
    let stderr = ''
    const dryRunCode = await run(
      [
        '--dry-run',
        '--yes',
        '--verbose',
        'project',
        '--data-plane',
        'claude',
        'purge',
        '--json',
        project,
      ],
      {
        stdout: (message) => {
          stdout += message.toString()
        },
        stderr: (message) => {
          stderr += message
        },
      },
    )
    if (dryRunCode !== 0) throw new Error(`${stderr}${stdout}`)
    expect(JSON.parse(stdout)).toMatchObject({
      type: 'project-purge',
      result: { dryRun: true, failures: [] },
    })
    await expect(
      readFile(join(configRoot, 'tasks', SESSION_ID, 'task.json'), 'utf8'),
    ).resolves.toBe('{}')

    stdout = ''
    const code = await run(
      [
        'project',
        'purge',
        '--data-plane',
        'claude',
        '--yes',
        '--json',
        project,
      ],
      {
        stdout: (message) => {
          stdout += message.toString()
        },
        stderr: () => undefined,
      },
    )
    expect(code).toBe(0)
    expect(JSON.parse(stdout).result.failures).toEqual([])
    await expect(
      readFile(join(configRoot, '.claude.json'), 'utf8'),
    ).resolves.toContain('"projects": {}')
  })

  it('requires explicit confirmation in non-interactive mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-purge-cli-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const project = join(root, 'project')
    const projectRoot = join(
      configRoot,
      'projects',
      sanitizeClaudeProjectPath(project),
    )
    await mkdir(configRoot, { recursive: true })
    await mkdir(project, { recursive: true })
    await mkdir(projectRoot, { recursive: true })
    await writeFile(join(configRoot, '.claude.json'), '{}')
    await writeFile(join(projectRoot, `${SESSION_ID}.jsonl`), '{}\n')
    vi.stubEnv('CLAUDE_CONFIG_DIR', configRoot)
    let stderr = ''
    const code = await run(
      ['project', 'purge', '--data-plane', 'claude', project],
      {
        stdout: () => undefined,
        stderr: (message) => {
          stderr += message
        },
      },
    )
    expect(code).toBe(1)
    expect(stderr).toContain('requires --yes without stdin')
  })

  it('purges the default Claude state path outside the config directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-purge-cli-'))
    roots.push(root)
    const home = join(root, 'home')
    const configRoot = join(home, '.claude')
    const statePath = join(home, '.claude.json')
    const project = join(root, 'project')
    await mkdir(configRoot, { recursive: true })
    await mkdir(project, { recursive: true })
    await writeFile(
      statePath,
      JSON.stringify({ projects: { [project]: { keep: true } } }),
    )
    vi.stubEnv('HOME', home)
    vi.stubEnv('CLAUDE_CONFIG_DIR', '')

    const code = await run(
      ['project', 'purge', '--data-plane', 'claude', '--yes', project],
      {
        stdout: () => undefined,
        stderr: () => undefined,
      },
    )

    expect(code).toBe(0)
    await expect(readFile(statePath, 'utf8')).resolves.toContain(
      '"projects": {}',
    )
  })

  it('purges native sessions without reading or deleting Claude state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-purge-cli-'))
    roots.push(root)
    const praxisRoot = join(root, 'praxis')
    const claudeRoot = join(root, 'claude')
    const project = join(root, 'project')
    const projectKey = sanitizeClaudeProjectPath(project)
    const nativeSession = join(
      praxisRoot,
      'sessions',
      projectKey,
      `${SESSION_ID}.jsonl`,
    )
    const claudeSession = join(
      claudeRoot,
      'projects',
      projectKey,
      `${SESSION_ID}.jsonl`,
    )
    await mkdir(join(praxisRoot, 'tasks', SESSION_ID), { recursive: true })
    await mkdir(join(praxisRoot, 'sessions', projectKey), { recursive: true })
    await mkdir(join(claudeRoot, 'projects', projectKey), { recursive: true })
    await mkdir(project, { recursive: true })
    await writeFile(nativeSession, '{}\n')
    await writeFile(claudeSession, 'claude-marker\n')
    await writeFile(
      join(praxisRoot, 'state.json'),
      JSON.stringify({ projects: { [project]: { native: true } } }),
    )
    await writeFile(
      join(claudeRoot, '.claude.json'),
      JSON.stringify({ projects: { [project]: { claude: true } } }),
    )
    vi.stubEnv('PRAXIS_HOME', praxisRoot)
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeRoot)

    const code = await run(['project', 'purge', '--yes', project], {
      stdout: () => undefined,
      stderr: () => undefined,
    })

    expect(code).toBe(0)
    await expect(readFile(nativeSession, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(
      readFile(join(praxisRoot, 'state.json'), 'utf8'),
    ).resolves.toContain('"projects": {}')
    await expect(readFile(claudeSession, 'utf8')).resolves.toBe(
      'claude-marker\n',
    )
    await expect(
      readFile(join(claudeRoot, '.claude.json'), 'utf8'),
    ).resolves.toContain('"claude":true')
  })
})
