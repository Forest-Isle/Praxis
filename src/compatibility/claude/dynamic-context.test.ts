import { describe, expect, it } from 'vitest'

import {
  loadClaudeDynamicContext,
  renderClaudeDynamicSystemContext,
  renderClaudeDynamicUserContext,
} from './dynamic-context.js'

describe('Claude dynamic context', () => {
  it('captures deterministic environment, memory, and git sections', async () => {
    const outputs = new Map([
      ['rev-parse --is-inside-work-tree', 'true\n'],
      ['branch --show-current', 'feature\n'],
      ['branch --format=%(refname:short)', 'feature\nmain\n'],
      ['config user.name', 'Fixture User\n'],
      ['status --short --untracked-files=all', ' M tracked.ts\n?? new.ts\n'],
      ['log -5 --oneline', 'abc1234 latest\n'],
    ])
    const sections = await loadClaudeDynamicContext({
      cwd: '/workspace',
      memoryDirectory: '/config/projects/workspace/memory',
      shell: '/bin/zsh',
      platform: 'darwin',
      osVersion: 'Darwin 24.6.0',
      runGit: async (args) => {
        const key = args.join(' ')
        const value = outputs.get(key)
        if (value === undefined) throw new Error(`Unexpected git call: ${key}`)
        return value
      },
    })

    expect(sections.environment).toContain(
      'Primary working directory: /workspace',
    )
    expect(sections.environment).toContain('Is a git repository: true')
    expect(sections.environment).toContain('Shell: zsh')
    expect(sections.memory).toContain('/config/projects/workspace/memory')
    expect(sections.gitStatus).toContain('Current branch: feature')
    expect(sections.gitStatus).toContain('Main branch: main')
    expect(sections.gitStatus).toContain(' M tracked.ts\n?? new.ts')
    expect(renderClaudeDynamicSystemContext(sections)).toMatch(
      /# Memory[\s\S]*# Environment[\s\S]*# gitStatus/,
    )
    expect(renderClaudeDynamicUserContext(sections)).toMatch(
      /<system-reminder>[\s\S]*# gitStatus[\s\S]*# Environment[\s\S]*# Memory/,
    )
  })

  it('reports a non-git environment without a git section', async () => {
    const sections = await loadClaudeDynamicContext({
      cwd: '/workspace',
      shell: 'fish',
      platform: 'linux',
      osVersion: 'Linux fixture',
      runGit: async () => {
        throw new Error('not a repository')
      },
    })

    expect(sections).toEqual({
      environment: `# Environment
Praxis was invoked in the following environment:
- Primary working directory: /workspace
- Is a git repository: false
- Platform: linux
- Shell: fish
- OS Version: Linux fixture`,
    })
  })

  it('does not report a failed or truncated git status as clean', async () => {
    const base = new Map([
      ['rev-parse --is-inside-work-tree', 'true\n'],
      ['branch --show-current', 'feature\n'],
      ['branch --format=%(refname:short)', 'feature\nmain\n'],
      ['config user.name', 'Fixture User\n'],
      ['log -5 --oneline', 'abc1234 latest\n'],
    ])
    const failed = await loadClaudeDynamicContext({
      cwd: '/workspace',
      runGit: async (args) => {
        const key = args.join(' ')
        if (key === 'status --short --untracked-files=all') {
          throw new Error('status failed')
        }
        const output = base.get(key)
        if (output === undefined) throw new Error(`Unexpected git call: ${key}`)
        return output
      },
    })
    expect(failed.gitStatus).toContain('Status:\nUnavailable')
    expect(failed.gitStatus).not.toContain('Status:\nClean')

    const truncated = await loadClaudeDynamicContext({
      cwd: '/workspace',
      runGit: async (args) => {
        const key = args.join(' ')
        if (key === 'status --short --untracked-files=all') {
          return { output: '?? partial-file\n', truncated: true }
        }
        const output = base.get(key)
        if (output === undefined) throw new Error(`Unexpected git call: ${key}`)
        return output
      },
    })
    expect(truncated.gitStatus).toContain(
      'Status:\n?? partial-file\n... [truncated]',
    )
    expect(truncated.gitStatus).not.toContain('Status:\nClean')
  })
})
