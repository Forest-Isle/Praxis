import { describe, expect, it } from 'vitest'

import { ClaudePermissionResolver } from './claude-permission-resolver.js'

describe('ClaudePermissionResolver', () => {
  it('allows Agent by default while preserving explicit deny rules', async () => {
    const call = { id: 'agent', name: 'Agent', input: {} }
    await expect(
      new ClaudePermissionResolver({ cwd: '/workspace', settings: [] }).resolve(
        call,
      ),
    ).resolves.toEqual({ behavior: 'allow' })
    await expect(
      new ClaudePermissionResolver({
        cwd: '/workspace',
        settings: [
          {
            path: '/config/settings.json',
            scope: 'user',
            value: { permissions: { deny: ['Agent'] } },
          },
        ],
      }).resolve(call),
    ).resolves.toEqual({
      behavior: 'deny',
      reason: 'Denied by Claude permission rule Agent',
    })
    await expect(
      new ClaudePermissionResolver({
        cwd: '/workspace',
        settings: [
          {
            path: '/config/settings.json',
            scope: 'user',
            value: { permissions: { deny: ['Agent(reviewer)'] } },
          },
        ],
      }).resolve({
        ...call,
        input: { subagent_type: 'reviewer' },
      }),
    ).resolves.toEqual({
      behavior: 'deny',
      reason: 'Denied by Claude permission rule Agent(reviewer)',
    })
  })

  it('applies deny, ask, allow, and safe defaults to normalized tool calls', async () => {
    const resolver = new ClaudePermissionResolver({
      cwd: '/workspace',
      settings: [
        {
          path: '/config/settings.json',
          scope: 'user',
          value: {
            permissions: {
              allow: ['Read', 'Bash(git status)', 'Bash(npm test:*)'],
              ask: ['Write'],
              deny: [
                'Read(**/.env)',
                'Read(//workspace/secrets/**)',
                'Read(~/private/**)',
                'Bash(rm *)',
              ],
            },
          },
        },
      ],
    })

    await expect(
      resolver.resolve({
        id: 'read_source',
        name: 'Read',
        input: { file_path: '/workspace/src/index.ts' },
      }),
    ).resolves.toEqual({ behavior: 'allow' })
    await expect(
      new ClaudePermissionResolver({ cwd: '/workspace', settings: [] }).resolve(
        { id: 'glob', name: 'Glob', input: { pattern: '**/*.ts' } },
      ),
    ).resolves.toEqual({ behavior: 'allow' })
    await expect(
      new ClaudePermissionResolver({ cwd: '/workspace', settings: [] }).resolve(
        {
          id: 'resource',
          name: 'ReadMcpResourceTool',
          input: { server: 'fixture', uri: 'fixture://alpha' },
        },
      ),
    ).resolves.toEqual({ behavior: 'allow' })
    for (const call of [
      {
        id: 'web-fetch',
        name: 'WebFetch',
        input: { url: 'https://example.com/docs', prompt: 'read' },
      },
      {
        id: 'web-search',
        name: 'WebSearch',
        input: { query: 'current docs' },
      },
    ]) {
      await expect(
        new ClaudePermissionResolver({
          cwd: '/workspace',
          settings: [],
        }).resolve(call),
      ).resolves.toEqual({ behavior: 'ask' })
    }
    await expect(
      new ClaudePermissionResolver({
        cwd: '/workspace',
        settings: [],
        allowedTools: ['WebFetch(domain:example.com)'],
      }).resolve({
        id: 'allowed-web-fetch',
        name: 'WebFetch',
        input: { url: 'https://example.com/docs', prompt: 'read' },
      }),
    ).resolves.toEqual({ behavior: 'allow' })
    await expect(
      new ClaudePermissionResolver({
        cwd: '/workspace',
        settings: [],
        disallowedTools: ['Glob(/workspace/private/**)'],
      }).resolve({
        id: 'glob-private',
        name: 'Glob',
        input: { pattern: '**/*', path: 'private/src' },
      }),
    ).resolves.toEqual({
      behavior: 'deny',
      reason: 'Denied by Claude permission rule Glob(/workspace/private/**)',
    })
    const notebookEdit = {
      id: 'notebook-edit',
      name: 'NotebookEdit',
      input: { notebook_path: '/workspace/notebook.ipynb' },
    }
    await expect(
      new ClaudePermissionResolver({ cwd: '/workspace', settings: [] }).resolve(
        notebookEdit,
      ),
    ).resolves.toEqual({ behavior: 'ask' })
    await expect(
      new ClaudePermissionResolver({
        cwd: '/workspace',
        settings: [],
        disallowedTools: ['NotebookEdit(/workspace/*.ipynb)'],
      }).resolve(notebookEdit),
    ).resolves.toEqual({
      behavior: 'deny',
      reason:
        'Denied by Claude permission rule NotebookEdit(/workspace/*.ipynb)',
    })
    await expect(
      new ClaudePermissionResolver({
        cwd: '/workspace',
        settings: [],
        permissionMode: 'acceptEdits',
      }).resolve(notebookEdit),
    ).resolves.toEqual({ behavior: 'allow' })
    await expect(
      new ClaudePermissionResolver({
        cwd: '/workspace',
        settings: [],
        permissionMode: 'plan',
        allowedTools: ['NotebookEdit'],
      }).resolve(notebookEdit),
    ).resolves.toMatchObject({ behavior: 'deny' })
    await expect(
      resolver.resolve({
        id: 'npm_test',
        name: 'Bash',
        input: { command: 'npm test -- --run runtime.test.ts' },
      }),
    ).resolves.toEqual({ behavior: 'allow' })
    await expect(
      resolver.resolve({
        id: 'npm_test_injected',
        name: 'Bash',
        input: { command: 'npm test && rm generated.txt' },
      }),
    ).resolves.toEqual({ behavior: 'ask' })
    await expect(
      resolver.resolve({
        id: 'read_secret',
        name: 'Read',
        input: { file_path: '/workspace/.env' },
      }),
    ).resolves.toEqual({
      behavior: 'deny',
      reason: 'Denied by Claude permission rule Read(**/.env)',
    })
    await expect(
      resolver.resolve({
        id: 'read_double_slash',
        name: 'Read',
        input: { file_path: '/workspace/secrets/key.txt' },
      }),
    ).resolves.toMatchObject({ behavior: 'deny' })
    const homeResolver = new ClaudePermissionResolver({
      cwd: '/workspace',
      homeDirectory: '/home/fixture',
      settings: [
        {
          path: '/config/settings.json',
          scope: 'user',
          value: { permissions: { deny: ['Read(~/private/**)'] } },
        },
      ],
    })
    await expect(
      homeResolver.resolve({
        id: 'read_home',
        name: 'Read',
        input: { file_path: '/home/fixture/private/key.txt' },
      }),
    ).resolves.toMatchObject({ behavior: 'deny' })
    await expect(
      resolver.resolve({
        id: 'write',
        name: 'Write',
        input: { file_path: '/workspace/output.txt' },
      }),
    ).resolves.toEqual({ behavior: 'ask' })
    await expect(
      resolver.resolve({
        id: 'search',
        name: 'Grep',
        input: { path: '/workspace/src', pattern: 'TODO' },
      }),
    ).resolves.toEqual({ behavior: 'allow' })
    await expect(
      resolver.resolve({
        id: 'git',
        name: 'Bash',
        input: { command: 'git status' },
      }),
    ).resolves.toEqual({ behavior: 'allow' })
    await expect(
      resolver.resolve({
        id: 'shell',
        name: 'Bash',
        input: { command: 'node script.js' },
      }),
    ).resolves.toEqual({ behavior: 'ask' })
    await expect(
      resolver.resolve({
        id: 'dangerous',
        name: 'Bash',
        input: { command: 'rm generated.txt' },
      }),
    ).resolves.toEqual({
      behavior: 'deny',
      reason: 'Denied by Claude permission rule Bash(rm *)',
    })
  })

  it('lets deny rules win across user, project, and local settings', async () => {
    const resolver = new ClaudePermissionResolver({
      cwd: '/workspace',
      settings: [
        {
          path: '/config/settings.json',
          scope: 'user',
          value: { permissions: { allow: ['Bash(npm *)'] } },
        },
        {
          path: '/workspace/.claude/settings.json',
          scope: 'project',
          value: { permissions: { ask: ['Bash(npm publish)'] } },
        },
        {
          path: '/workspace/.claude/settings.local.json',
          scope: 'local',
          value: { permissions: { deny: ['Bash(npm publish)'] } },
        },
      ],
    })

    await expect(
      resolver.resolve({
        id: 'publish',
        name: 'Bash',
        input: { command: 'npm publish' },
      }),
    ).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('applies CLI rules and permission modes without bypassing explicit deny', async () => {
    const write = {
      id: 'write',
      name: 'Write',
      input: { file_path: '/workspace/output.txt' },
    }
    await expect(
      new ClaudePermissionResolver({
        cwd: '/workspace',
        settings: [],
        permissionMode: 'acceptEdits',
      }).resolve(write),
    ).resolves.toEqual({ behavior: 'allow' })
    await expect(
      new ClaudePermissionResolver({
        cwd: '/workspace',
        settings: [],
        permissionMode: 'dontAsk',
      }).resolve(write),
    ).resolves.toMatchObject({ behavior: 'deny' })
    await expect(
      new ClaudePermissionResolver({
        cwd: '/workspace',
        settings: [],
        permissionMode: 'plan',
        allowedTools: ['Write'],
      }).resolve(write),
    ).resolves.toMatchObject({ behavior: 'deny' })
    await expect(
      new ClaudePermissionResolver({
        cwd: '/workspace',
        settings: [],
        permissionMode: 'bypassPermissions',
        disallowedTools: ['Write'],
      }).resolve(write),
    ).resolves.toMatchObject({ behavior: 'deny' })
    expect(
      () =>
        new ClaudePermissionResolver({
          cwd: '/workspace',
          settings: [],
          permissionMode: 'auto',
        }),
    ).toThrow('requires a classifier')
  })
})
