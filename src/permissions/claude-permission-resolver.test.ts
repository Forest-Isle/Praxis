import { describe, expect, it } from 'vitest'

import {
  autoModePermissionOutcome,
  permissionDecisionSource,
} from '../core/runtime.js'
import {
  claudePermissionRuleMatches,
  ClaudePermissionResolver,
} from './claude-permission-resolver.js'

describe('ClaudePermissionResolver', () => {
  it('matches exact command, domain, and filesystem permission rules', () => {
    expect(
      claudePermissionRuleMatches(
        'Bash(npm test)',
        { id: 'bash', name: 'Bash', input: { command: 'npm test' } },
        '/workspace',
      ),
    ).toBe(true)
    expect(
      claudePermissionRuleMatches(
        'Bash(npm test)',
        { id: 'bash-other', name: 'Bash', input: { command: 'npm test:e2e' } },
        '/workspace',
      ),
    ).toBe(false)
    expect(
      claudePermissionRuleMatches(
        'Bash(npm run:*)',
        {
          id: 'bash-safe-env',
          name: 'Bash',
          input: { command: 'NODE_ENV=test npm run build' },
        },
        '/workspace',
      ),
    ).toBe(true)
    expect(
      claudePermissionRuleMatches(
        'Bash(npm run:*)',
        {
          id: 'bash-unsafe-env',
          name: 'Bash',
          input: { command: 'CUSTOM_TARGET=test npm run build' },
        },
        '/workspace',
      ),
    ).toBe(false)
    expect(
      claudePermissionRuleMatches(
        'WebFetch(domain:*.example.com)',
        {
          id: 'fetch',
          name: 'WebFetch',
          input: { url: 'https://docs.example.com/guide' },
        },
        '/workspace',
      ),
    ).toBe(true)
    expect(
      claudePermissionRuleMatches(
        'Read(src/**)',
        {
          id: 'read',
          name: 'Read',
          input: { file_path: '/workspace/src/index.ts' },
        },
        '/workspace',
      ),
    ).toBe(true)
    expect(
      claudePermissionRuleMatches(
        'PowerShell(Get-ChildItem)',
        {
          id: 'powershell',
          name: 'PowerShell',
          input: { command: 'Get-ChildItem' },
        },
        '/workspace',
      ),
    ).toBe(true)
    expect(
      claudePermissionRuleMatches(
        'Skill(reviewer)',
        {
          id: 'skill',
          name: 'Skill',
          input: { skill: 'reviewer' },
        },
        '/workspace',
      ),
    ).toBe(true)
    expect(
      claudePermissionRuleMatches(
        'Skill(reviewer:*)',
        {
          id: 'skill-prefix',
          name: 'Skill',
          input: { skill: 'reviewer strict' },
        },
        '/workspace',
      ),
    ).toBe(true)
    expect(
      claudePermissionRuleMatches(
        'Edit(/.claude/**)',
        {
          id: 'write-settings',
          name: 'Write',
          input: { file_path: '/workspace/.claude/settings.local.json' },
        },
        '/workspace',
      ),
    ).toBe(true)
    expect(
      claudePermissionRuleMatches(
        'Read(//shared/**)',
        {
          id: 'grep-shared',
          name: 'Grep',
          input: { path: '/shared/src', pattern: 'TODO' },
        },
        '/workspace',
      ),
    ).toBe(true)
  })

  it.each(['default', 'manual'] as const)(
    'honors immediate session approvals in %s mode',
    async (permissionMode) => {
      const call = {
        id: 'bash-approved',
        name: 'Bash',
        input: { command: 'npm test' },
      }
      await expect(
        new ClaudePermissionResolver({
          cwd: '/workspace',
          settings: [],
          permissionMode,
          isSessionActionApproved: (candidate) => candidate === call,
        }).resolve(call),
      ).resolves.toEqual({ behavior: 'allow' })
    },
  )

  it('keeps explicit deny and plan-mode restrictions ahead of session approval', async () => {
    const bash = {
      id: 'bash-denied',
      name: 'Bash',
      input: { command: 'rm output.txt' },
    }
    await expect(
      new ClaudePermissionResolver({
        cwd: '/workspace',
        settings: [],
        disallowedTools: ['Bash(rm *)'],
        isSessionActionApproved: () => true,
      }).resolve(bash),
    ).resolves.toMatchObject({ behavior: 'deny' })

    await expect(
      new ClaudePermissionResolver({
        cwd: '/workspace',
        settings: [],
        permissionMode: 'plan',
        isSessionActionApproved: () => true,
      }).resolve({
        id: 'write-plan',
        name: 'Write',
        input: { file_path: '/workspace/output.txt', content: 'value' },
      }),
    ).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('resolves leading-slash file rules from their settings source root', async () => {
    const resolver = new ClaudePermissionResolver({
      cwd: '/workspace/project',
      homeDirectory: '/home/fixture',
      settings: [
        {
          path: '/home/fixture/.claude/settings.json',
          scope: 'user',
          value: { permissions: { deny: ['Read(/skills/**)'] } },
        },
        {
          path: '/workspace/project/.claude/settings.local.json',
          scope: 'local',
          value: { permissions: { allow: ['Edit(/.claude/**)'] } },
        },
      ],
    })

    await expect(
      resolver.resolve({
        id: 'read-user-skill',
        name: 'Read',
        input: { file_path: '/home/fixture/.claude/skills/reviewer/SKILL.md' },
      }),
    ).resolves.toEqual({
      behavior: 'deny',
      reason: 'Denied by Claude permission rule Read(/skills/**)',
    })
    await expect(
      resolver.resolve({
        id: 'write-project-settings',
        name: 'Write',
        input: { file_path: '/workspace/project/.claude/settings.local.json' },
      }),
    ).resolves.toEqual({ behavior: 'allow' })
  })

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

  it('requires explicit review for dynamic workflows', async () => {
    await expect(
      new ClaudePermissionResolver({ cwd: '/workspace', settings: [] }).resolve(
        {
          id: 'workflow',
          name: 'Workflow',
          input: { script: 'source' },
        },
      ),
    ).resolves.toEqual({
      behavior: 'ask',
      reason: 'Review dynamic workflow before running',
    })
  })

  it('allows SendUserMessage without an interactive permission prompt', async () => {
    await expect(
      new ClaudePermissionResolver({ cwd: '/workspace', settings: [] }).resolve(
        {
          id: 'message',
          name: 'SendUserMessage',
          input: { message: 'done', status: 'normal' },
        },
      ),
    ).resolves.toEqual({ behavior: 'allow' })
  })

  it('allows durable task graph tools by default with explicit deny precedence', async () => {
    const resolver = new ClaudePermissionResolver({
      cwd: '/workspace',
      settings: [],
    })
    for (const name of ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate']) {
      await expect(
        resolver.resolve({ id: name, name, input: {} }),
      ).resolves.toEqual({ behavior: 'allow' })
    }
    await expect(
      new ClaudePermissionResolver({
        cwd: '/workspace',
        settings: [
          {
            path: '/config/settings.json',
            scope: 'user',
            value: { permissions: { deny: ['TaskUpdate'] } },
          },
        ],
      }).resolve({ id: 'deny-update', name: 'TaskUpdate', input: {} }),
    ).resolves.toEqual({
      behavior: 'deny',
      reason: 'Denied by Claude permission rule TaskUpdate',
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
        disallowedTools: ['Glob(//workspace/private/**)'],
      }).resolve({
        id: 'glob-private',
        name: 'Glob',
        input: { pattern: '**/*', path: 'private/src' },
      }),
    ).resolves.toEqual({
      behavior: 'deny',
      reason: 'Denied by Claude permission rule Glob(//workspace/private/**)',
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
    ).resolves.toEqual({
      behavior: 'ask',
      suggestions: [
        {
          type: 'setMode',
          mode: 'acceptEdits',
          destination: 'session',
        },
      ],
    })
    await expect(
      new ClaudePermissionResolver({
        cwd: '/workspace',
        settings: [],
        disallowedTools: ['NotebookEdit(//workspace/*.ipynb)'],
      }).resolve(notebookEdit),
    ).resolves.toEqual({
      behavior: 'deny',
      reason:
        'Denied by Claude permission rule NotebookEdit(//workspace/*.ipynb)',
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
    ).resolves.toEqual({
      behavior: 'deny',
      reason: 'Denied by Claude permission rule Bash(rm *)',
    })
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
    ).resolves.toEqual({
      behavior: 'ask',
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'node script.js' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    })
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

  it('resolves relative path rules against the execution context cwd', async () => {
    const resolver = new ClaudePermissionResolver({
      cwd: '/workspace/main',
      cwdProvider: () => '/workspace/main',
      settings: [
        {
          path: '/config/settings.json',
          scope: 'user',
          value: { permissions: { deny: ['Write(src/**)'] } },
        },
      ],
    })

    await expect(
      resolver.resolve(
        {
          id: 'isolated-write',
          name: 'Write',
          input: { file_path: '/workspace/agent-worktree/src/index.ts' },
        },
        { cwd: '/workspace/agent-worktree' },
      ),
    ).resolves.toEqual({
      behavior: 'deny',
      reason: 'Denied by Claude permission rule Write(src/**)',
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

  it('routes risky auto-mode actions through a context-aware classifier', async () => {
    const seen: Array<{ name: string; cwd: string; messages: number }> = []
    const resolver = new ClaudePermissionResolver({
      cwd: '/workspace',
      settings: [],
      permissionMode: 'auto',
      autoClassifier: async ({ call, cwd, messages }) => {
        seen.push({ name: call.name, cwd, messages: messages.length })
        return {
          behavior: call.name === 'Write' ? 'ask' : 'allow',
          ...(call.name === 'Write' ? { reason: 'classifier review' } : {}),
        }
      },
    })

    await expect(
      resolver.resolve(
        {
          id: 'read',
          name: 'Read',
          input: { file_path: '/workspace/src/index.ts' },
        },
        { cwd: '/workspace', messages: [{ role: 'user', content: 'inspect' }] },
      ),
    ).resolves.toEqual({ behavior: 'allow' })
    await expect(
      resolver.resolve({
        id: 'safe-shell',
        name: 'Bash',
        input: { command: 'pwd' },
      }),
    ).resolves.toEqual({ behavior: 'allow' })
    await expect(
      resolver.resolve({
        id: 'code-shell',
        name: 'Bash',
        input: { command: 'node -e "console.log(42)"' },
      }),
    ).resolves.toEqual({ behavior: 'allow' })
    await expect(
      resolver.resolve(
        {
          id: 'write',
          name: 'Write',
          input: { file_path: '/workspace/src/index.ts', content: 'next' },
        },
        { cwd: '/workspace', messages: [{ role: 'user', content: 'edit' }] },
      ),
    ).resolves.toEqual({ behavior: 'ask', reason: 'classifier review' })
    await expect(
      resolver.resolve(
        {
          id: 'agent',
          name: 'Agent',
          input: { subagent_type: 'general-purpose' },
        },
        { cwd: '/workspace', messages: [] },
      ),
    ).resolves.toEqual({ behavior: 'allow' })
    expect(seen).toEqual([
      { name: 'Bash', cwd: '/workspace', messages: 0 },
      { name: 'Write', cwd: '/workspace', messages: 1 },
      { name: 'Agent', cwd: '/workspace', messages: 0 },
    ])
  })

  it('loads auto-mode rule lists and supports $defaults composition', async () => {
    let configured: unknown
    const resolver = new ClaudePermissionResolver({
      cwd: '/workspace',
      permissionMode: 'auto',
      settings: [
        {
          path: '/config/settings.json',
          scope: 'user',
          value: {
            autoMode: {
              allow: ['$defaults', 'custom allow'],
              soft_deny: ['custom soft deny'],
              hard_deny: ['$defaults', 'custom hard deny'],
              environment: ['custom environment'],
              classifyAllShell: true,
            },
          },
        },
      ],
      autoClassifier: async (input) => {
        configured = input.config
        return { behavior: 'allow' }
      },
    })

    await resolver.resolve({
      id: 'shell',
      name: 'Bash',
      input: { command: 'printf safe' },
    })
    expect(configured).toMatchObject({
      allow: expect.arrayContaining(['custom allow']),
      softDeny: ['custom soft deny'],
      hardDeny: expect.arrayContaining(['custom hard deny']),
      environment: ['custom environment'],
      classifyAllShell: true,
    })
  })

  it('fails closed when auto classifier throws', async () => {
    const resolver = new ClaudePermissionResolver({
      cwd: '/workspace',
      settings: [],
      permissionMode: 'auto',
      autoClassifier: async () => {
        throw new Error('classifier unavailable')
      },
    })
    const decision = await resolver.resolve({
      id: 'write',
      name: 'Write',
      input: { file_path: '/workspace/output.txt', content: 'x' },
    })
    expect(decision).toEqual({
      behavior: 'deny',
      reason: 'Auto mode classifier failed: classifier unavailable',
    })
    expect(autoModePermissionOutcome(decision)).toBe('unavailable')
  })

  it('tracks auto classifier denials without changing the public decision shape', async () => {
    const resolver = new ClaudePermissionResolver({
      cwd: '/workspace',
      settings: [],
      permissionMode: 'auto',
      autoClassifier: async () => ({
        behavior: 'deny',
        reason: 'classifier policy',
      }),
    })
    const decision = await resolver.resolve({
      id: 'write',
      name: 'Write',
      input: { file_path: '/workspace/output.txt', content: 'x' },
    })
    expect(decision).toEqual({
      behavior: 'deny',
      reason: 'classifier policy',
    })
    expect(permissionDecisionSource(decision)).toBe('auto-classifier')
    expect(autoModePermissionOutcome(decision)).toBe('blocked')
  })

  it('bypasses the classifier only for a session-approved exact action', async () => {
    let classifierCalls = 0
    const resolver = new ClaudePermissionResolver({
      cwd: '/workspace',
      settings: [],
      permissionMode: 'auto',
      isSessionActionApproved: (call) =>
        call.name === 'Bash' && call.input.command === 'rm /tmp/target',
      autoClassifier: async () => {
        classifierCalls += 1
        return { behavior: 'deny', reason: 'classifier policy' }
      },
    })
    await expect(
      resolver.resolve({
        id: 'approved',
        name: 'Bash',
        input: { command: 'rm /tmp/target' },
      }),
    ).resolves.toEqual({ behavior: 'allow' })
    await expect(
      resolver.resolve({
        id: 'different',
        name: 'Bash',
        input: { command: 'rm /tmp/other' },
      }),
    ).resolves.toEqual({ behavior: 'deny', reason: 'classifier policy' })
    expect(classifierCalls).toBe(1)
  })

  it('does not identify rule and mode denials as auto classifier decisions', async () => {
    const rule = new ClaudePermissionResolver({
      cwd: '/workspace',
      settings: [],
      disallowedTools: ['Write'],
      permissionMode: 'auto',
      autoClassifier: async () => ({ behavior: 'allow' }),
    })
    const mode = new ClaudePermissionResolver({
      cwd: '/workspace',
      settings: [],
      permissionMode: 'plan',
    })
    expect(
      permissionDecisionSource(
        await rule.resolve({
          id: 'rule',
          name: 'Write',
          input: { file_path: '/workspace/output.txt', content: 'x' },
        }),
      ),
    ).toBe('rule')
    expect(
      permissionDecisionSource(
        await mode.resolve({
          id: 'mode',
          name: 'Write',
          input: { file_path: '/workspace/output.txt', content: 'x' },
        }),
      ),
    ).toBe('mode')
  })

  it('does not let an allow rule bypass auto classification for risky actions', async () => {
    const resolver = new ClaudePermissionResolver({
      cwd: '/workspace',
      settings: [],
      allowedTools: ['Agent'],
      permissionMode: 'auto',
      autoClassifier: async () => ({
        behavior: 'deny',
        reason: 'classifier policy',
      }),
    })
    await expect(
      resolver.resolve({
        id: 'agent',
        name: 'Agent',
        input: { subagent_type: 'general-purpose' },
      }),
    ).resolves.toEqual({ behavior: 'deny', reason: 'classifier policy' })
  })

  it('allows built-in scheduling lifecycle tools by default', async () => {
    const resolver = new ClaudePermissionResolver({
      cwd: '/workspace',
      settings: [],
    })

    for (const name of [
      'CronCreate',
      'CronDelete',
      'CronList',
      'ScheduleWakeup',
    ]) {
      await expect(
        resolver.resolve({ id: `call_${name}`, name, input: {} }),
      ).resolves.toEqual({ behavior: 'allow' })
    }

    await expect(
      new ClaudePermissionResolver({
        cwd: '/workspace',
        settings: [],
        disallowedTools: ['ScheduleWakeup'],
      }).resolve({ id: 'denied', name: 'ScheduleWakeup', input: {} }),
    ).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('suggests and applies session updates for paths outside working roots', async () => {
    const resolver = new ClaudePermissionResolver({
      cwd: '/workspace',
      settings: [],
    })
    const read = {
      id: 'read-outside',
      name: 'Read',
      input: { file_path: '/shared/config.json' },
    }
    const readDecision = await resolver.resolve(read, { cwd: '/workspace' })
    expect(readDecision).toEqual({
      behavior: 'ask',
      reason: 'Path is outside allowed working directories',
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Read', ruleContent: '//shared/**' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    })
    await expect(
      resolver.resolve(read, {
        cwd: '/workspace',
        permissionUpdates:
          readDecision.behavior === 'ask'
            ? (readDecision.suggestions ?? [])
            : [],
      }),
    ).resolves.toEqual({ behavior: 'allow' })

    const write = {
      id: 'write-outside',
      name: 'Write',
      input: { file_path: '/shared/output.txt', content: 'value' },
    }
    const writeDecision = await resolver.resolve(write, { cwd: '/workspace' })
    expect(writeDecision).toMatchObject({
      behavior: 'ask',
      suggestions: [
        {
          type: 'setMode',
          mode: 'acceptEdits',
          destination: 'session',
        },
        {
          type: 'addDirectories',
          directories: ['/shared'],
          destination: 'session',
        },
      ],
    })
    await expect(
      resolver.resolve(write, {
        cwd: '/workspace',
        permissionUpdates:
          writeDecision.behavior === 'ask'
            ? (writeDecision.suggestions ?? [])
            : [],
      }),
    ).resolves.toEqual({ behavior: 'allow' })
  })

  it('applies replace and remove rule updates to their original destination', async () => {
    const resolver = new ClaudePermissionResolver({
      cwd: '/workspace',
      settings: [
        {
          path: '/workspace/.claude/settings.local.json',
          scope: 'local',
          value: { permissions: { allow: ['Bash(npm test:*)'] } },
        },
      ],
    })
    const npmTest = {
      id: 'npm-test',
      name: 'Bash',
      input: { command: 'npm test -- --run' },
    }
    await expect(resolver.resolve(npmTest)).resolves.toEqual({
      behavior: 'allow',
    })
    await expect(
      resolver.resolve(npmTest, {
        cwd: '/workspace',
        permissionUpdates: [
          {
            type: 'removeRules',
            rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
      }),
    ).resolves.toMatchObject({ behavior: 'ask' })
    const replacement = [
      {
        type: 'replaceRules' as const,
        rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }],
        behavior: 'allow' as const,
        destination: 'localSettings' as const,
      },
    ]
    await expect(
      resolver.resolve(npmTest, {
        cwd: '/workspace',
        permissionUpdates: replacement,
      }),
    ).resolves.toMatchObject({ behavior: 'ask' })
    await expect(
      resolver.resolve(
        {
          id: 'git-status',
          name: 'Bash',
          input: { command: 'git status --short' },
        },
        { cwd: '/workspace', permissionUpdates: replacement },
      ),
    ).resolves.toEqual({ behavior: 'allow' })
  })

  it('removes configured additional directories from the current context', async () => {
    const resolver = new ClaudePermissionResolver({
      cwd: '/workspace',
      settings: [],
      additionalDirectories: ['/shared'],
    })
    const write = {
      id: 'write-shared',
      name: 'Write',
      input: { file_path: '/shared/output.txt', content: 'value' },
    }
    await expect(resolver.resolve(write)).resolves.toMatchObject({
      behavior: 'ask',
      suggestions: [{ type: 'setMode' }],
    })
    await expect(
      resolver.resolve(write, {
        cwd: '/workspace',
        permissionUpdates: [
          {
            type: 'removeDirectories',
            directories: ['/shared'],
            destination: 'session',
          },
        ],
      }),
    ).resolves.toMatchObject({
      behavior: 'ask',
      reason: 'Path is outside allowed working directories',
    })
  })

  it('builds compound Bash suggestions from non-read-only subcommands', async () => {
    const decision = await new ClaudePermissionResolver({
      cwd: '/workspace',
      settings: [],
    }).resolve({
      id: 'compound',
      name: 'Bash',
      input: { command: 'cd src && npm test && git push' },
    })
    expect(decision).toMatchObject({
      behavior: 'ask',
      suggestions: [
        {
          type: 'addRules',
          rules: [
            { toolName: 'Bash', ruleContent: 'npm test:*' },
            { toolName: 'Bash', ruleContent: 'git push:*' },
          ],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    })
  })

  it('omits already allowed and read-only compound subcommands', async () => {
    const resolver = new ClaudePermissionResolver({
      cwd: '/workspace',
      settings: [],
      allowedTools: ['Bash(npm test:*)'],
    })
    await expect(
      resolver.resolve({
        id: 'partially-allowed',
        name: 'Bash',
        input: { command: 'cd src && npm test && git push' },
      }),
    ).resolves.toMatchObject({
      behavior: 'ask',
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'git push:*' }],
        },
      ],
    })
    await expect(
      resolver.resolve({
        id: 'read-only',
        name: 'Bash',
        input: { command: 'cd src && ls -la' },
      }),
    ).resolves.toEqual({ behavior: 'allow' })
  })

  it('uses Bash AST units for nested commands, redirects, and parse failures', async () => {
    const denied = new ClaudePermissionResolver({
      cwd: '/workspace',
      settings: [],
      disallowedTools: ['Bash(rm:*)'],
    })
    await expect(
      denied.resolve({
        id: 'nested-deny',
        name: 'Bash',
        input: { command: 'echo $(rm -rf build)' },
      }),
    ).resolves.toMatchObject({ behavior: 'deny' })

    const allowedPrefix = new ClaudePermissionResolver({
      cwd: '/workspace',
      settings: [],
      allowedTools: ['Bash(npm test:*)', 'Bash(echo:*)'],
    })
    await expect(
      allowedPrefix.resolve({
        id: 'redirect',
        name: 'Bash',
        input: { command: 'npm test > output.log 2>&1' },
      }),
    ).resolves.toMatchObject({
      behavior: 'ask',
      suggestions: [
        {
          type: 'addRules',
          rules: [
            {
              toolName: 'Bash',
              ruleContent: 'npm test > output.log 2>&1',
            },
          ],
        },
      ],
    })
    await expect(
      allowedPrefix.resolve({
        id: 'malformed',
        name: 'Bash',
        input: { command: "echo 'unterminated && rm -rf build" },
      }),
    ).resolves.toMatchObject({ behavior: 'ask' })
  })

  it('blocks structural expansion of legacy wildcards but honors exact glob commands', async () => {
    const legacy = new ClaudePermissionResolver({
      cwd: '/workspace',
      settings: [],
      allowedTools: ['Bash(npm *)'],
    })
    await expect(
      legacy.resolve({
        id: 'legacy-compound',
        name: 'Bash',
        input: { command: 'npm test && rm generated.txt' },
      }),
    ).resolves.toMatchObject({ behavior: 'ask' })

    await expect(
      new ClaudePermissionResolver({
        cwd: '/workspace',
        settings: [],
        allowedTools: ['Bash(rm *.tmp > removed.log)'],
      }).resolve({
        id: 'exact-glob',
        name: 'Bash',
        input: { command: 'rm *.tmp > removed.log' },
      }),
    ).resolves.toEqual({ behavior: 'allow' })
  })
})
