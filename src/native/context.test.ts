import { describe, expect, it } from 'vitest'

import { projectContextSnapshot } from '../core/context.js'
import { loadClaudeDynamicContext } from './dynamic-context.js'
import { ClaudeContextAssembler } from './context.js'

function gitLoader(status: string, calls: (readonly string[])[]) {
  return async (args: readonly string[]) => {
    calls.push(args)
    if (args[0] === 'rev-parse') return 'true'
    if (args[0] === '--no-optional-locks')
      return { output: status, truncated: false }
    if (args[0] === 'branch')
      return args[1] === '--show-current' ? 'main' : 'main'
    if (args[0] === 'config') return 'Tester'
    if (args[0] === 'log') return 'abc123 commit'
    return ''
  }
}

const loadEmptyResources = async () => ({
  instructions: [],
  conditionalRules: [],
  memoryIndex: null,
})

describe('native dynamic and assembled context', () => {
  it('uses the exact no-optional-locks status argv', async () => {
    const calls: (readonly string[])[] = []
    await loadClaudeDynamicContext({
      cwd: '/project',
      runGit: gitLoader('', calls),
    })
    expect(calls).toContainEqual([
      '--no-optional-locks',
      'status',
      '--short',
      '--untracked-files=all',
    ])
  })

  it('bounds multibyte git status with a valid UTF-8 marker', async () => {
    const calls: (readonly string[])[] = []
    const context = await loadClaudeDynamicContext({
      cwd: '/project',
      runGit: gitLoader('界'.repeat(2_000), calls),
    })
    expect(context.gitStatus).toBeDefined()
    const gitStatus = context.gitStatus ?? ''
    expect(Buffer.byteLength(gitStatus, 'utf8')).toBeLessThanOrEqual(2_048)
    expect(gitStatus).toMatch(/\.\.\. \[truncated\]$/)
    expect(gitStatus).not.toContain('\uFFFD')
  })

  it('omits git status when the status command fails without rejecting', async () => {
    const context = await loadClaudeDynamicContext({
      cwd: '/project',
      runGit: async (args) => {
        if (args[0] === 'rev-parse') return 'true'
        if (args[0] === '--no-optional-locks') throw new Error('status failed')
        return ''
      },
    })
    expect(context.gitStatus).toBeUndefined()
  })

  it('omits git status outside a repository', async () => {
    const context = await loadClaudeDynamicContext({
      cwd: '/project',
      runGit: async () => {
        throw new Error('not a repo')
      },
    })
    expect(context.gitStatus).toBeUndefined()
    expect(context.environment).toContain('- Is a git repository: false')
  })

  it('refreshes git while retaining stable environment and memory per lifecycle', async () => {
    let version = 0
    const assembler = new ClaudeContextAssembler({
      loadResources: loadEmptyResources,
      loadDynamicContext: async (cwd) => {
        version += 1
        return {
          environment: `ENV_${version}_${cwd}`,
          memory: `MEM_${version}`,
          gitStatus: `GIT_${version}`,
        }
      },
    })
    const first = await assembler.assemble({ lifecycleId: 'life', cwd: '/one' })
    const second = await assembler.assemble({
      lifecycleId: 'life',
      cwd: '/one',
    })
    const gitSection = first.sections.find(({ id }) => id === 'git-status')
    expect(gitSection).toMatchObject({
      placement: 'system',
      stability: 'volatile',
    })
    const gitSectionIndex = first.sections
      .filter(({ placement }) => placement === 'system')
      .findIndex(({ id }) => id === 'git-status')
    expect(gitSectionIndex).toBeGreaterThanOrEqual(0)
    expect(projectContextSnapshot(first).stableSystemSectionCount).toBe(
      gitSectionIndex,
    )
    expect(second.sections.find(({ id }) => id === 'git-status')?.content).toBe(
      'GIT_2',
    )
    expect(
      second.sections.find(({ id }) => id === 'runtime-context')?.content,
    ).toContain('ENV_1_/one')
    expect(
      second.sections.find(({ id }) => id === 'runtime-context')?.content,
    ).toContain('MEM_1')
    expect(
      second.sections.find(({ id }) => id === 'git-status')?.stability,
    ).toBe('volatile')
  })

  it('relocates fresh dynamic context into one volatile first-user wrapper', async () => {
    const assembler = new ClaudeContextAssembler({
      loadResources: loadEmptyResources,
      excludeDynamicSystemPromptSections: true,
      loadDynamicContext: async () => ({
        environment: 'ENV',
        memory: 'MEM',
        gitStatus: 'GIT',
      }),
    })
    const snapshot = await assembler.assemble({
      lifecycleId: 'life',
      cwd: '/one',
    })
    const relocated = snapshot.sections.find(
      ({ id }) => id === 'relocated-runtime-context',
    )
    expect(relocated).toMatchObject({
      placement: 'first-user',
      stability: 'volatile',
    })
    expect(relocated?.content).toContain('ENV')
    expect(relocated?.content).toContain('GIT')
    expect(
      snapshot.sections.filter(({ id }) => id === 'relocated-runtime-context'),
    ).toHaveLength(1)
  })

  it('uses each subagent cwd for its dynamic marker', async () => {
    const assembler = new ClaudeContextAssembler({
      loadResources: loadEmptyResources,
      loadDynamicContext: async (cwd) => ({
        environment: `ENV:${cwd}`,
        gitStatus: `GIT:${cwd}`,
      }),
    })
    const first = await assembler.assemble({
      mode: 'subagent',
      baseSystemPrompt: 'SUB',
      cwd: '/worktree-a',
    })
    const second = await assembler.assemble({
      mode: 'subagent',
      baseSystemPrompt: 'SUB',
      cwd: '/worktree-b',
    })
    expect(first.sections.find(({ id }) => id === 'git-status')?.content).toBe(
      'GIT:/worktree-a',
    )
    expect(second.sections.find(({ id }) => id === 'git-status')?.content).toBe(
      'GIT:/worktree-b',
    )
  })
})
