import { describe, expect, it } from 'vitest'

import { ClaudeExtensionCatalog } from './claude-extensions.js'

describe('ClaudeExtensionCatalog', () => {
  it('expands commands and skills into native command messages', () => {
    const catalog = new ClaudeExtensionCatalog({
      agents: [],
      commands: [
        {
          path: '/config/commands/review.md',
          scope: 'user',
          content:
            '---\ndescription: Review files.\n---\nARGS=[$ARGUMENTS] ZERO=[$0] ONE=[$1]',
        },
      ],
      skills: [
        {
          path: '/workspace/.claude/skills/check/SKILL.md',
          scope: 'project',
          content:
            '---\nname: check\ndescription: Check work.\n---\nCHECK [$ARGUMENTS]',
        },
      ],
    })

    expect(catalog.expandPrompt('/review alpha beta').userMessages).toEqual([
      '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>alpha beta</command-args>',
      'ARGS=[alpha beta] ZERO=[alpha] ONE=[beta]',
    ])
    expect(catalog.expandPrompt('/check target').userMessages).toEqual([
      '<command-message>check</command-message>\n<command-name>/check</command-name>\n<command-args>target</command-args>',
      'Base directory for this skill: /workspace/.claude/skills/check\n\nCHECK [target]',
    ])
  })

  it('uses the most specific definition and hides disabled model skills', () => {
    const catalog = new ClaudeExtensionCatalog({
      agents: [],
      commands: [],
      skills: [
        {
          path: '/config/skills/check/SKILL.md',
          scope: 'user',
          content: '---\nname: check\ndescription: User check.\n---\nUSER',
        },
        {
          path: '/workspace/.claude/skills/check/SKILL.md',
          scope: 'project',
          content:
            '---\nname: check\ndescription: Project check.\ndisable-model-invocation: true\n---\nPROJECT',
        },
      ],
    })

    expect(catalog.expandPrompt('/check').userMessages.at(-1)).toContain(
      'PROJECT',
    )
    expect(catalog.modelInvocableSkills().map(({ name }) => name)).toEqual([
      'loop',
    ])
  })

  it('keeps unknown slash prompts unchanged and resolves agents', () => {
    const catalog = new ClaudeExtensionCatalog({
      commands: [],
      skills: [],
      agents: [
        {
          path: '/config/agents/reviewer.md',
          scope: 'user',
          content:
            '---\nname: reviewer\ndescription: Review work.\n---\nAGENT_BODY',
        },
      ],
    })

    expect(catalog.expandPrompt('/unknown value').userMessages).toEqual([
      '/unknown value',
    ])
    expect(catalog.agent('reviewer')?.body).toBe('AGENT_BODY')
    expect(catalog.agentDefinitions()).toEqual([
      {
        name: 'general-purpose',
        description:
          'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.',
      },
      { name: 'reviewer', description: 'Review work.' },
    ])
    expect(
      catalog.agentMentionMessages('Ask @"reviewer (agent)" to inspect this'),
    ).toEqual([
      '<system-reminder>\nThe user has expressed a desire to invoke the agent "reviewer". Please invoke the agent appropriately, passing in the required context to it.\n</system-reminder>',
      '<system-reminder>\nAvailable agent types for the Agent tool:\n- general-purpose: General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.\n- reviewer: Review work.\n</system-reminder>',
    ])
    expect(
      catalog.agentMentionMessages('Read @"reviewer.md" as a file'),
    ).toEqual([])
  })

  it('keeps malformed bodies and gives a colliding skill precedence', () => {
    const catalog = new ClaudeExtensionCatalog({
      agents: [],
      commands: [
        {
          path: '/config/commands/probe.md',
          scope: 'user',
          content: 'COMMAND',
        },
      ],
      skills: [
        {
          path: '/config/skills/broken/SKILL.md',
          scope: 'user',
          content: '---\nname: [\n---\nBROKEN',
        },
        {
          path: '/config/skills/invalid-description/SKILL.md',
          scope: 'user',
          content: '---\ndescription: [invalid]\n---\nINVALID_DESCRIPTION',
        },
        {
          path: '/config/skills/invalid-flag/SKILL.md',
          scope: 'user',
          content: '---\ndisable-model-invocation: nope\n---\nINVALID_FLAG',
        },
        {
          path: '/config/skills/probe/SKILL.md',
          scope: 'user',
          content: '---\nname: probe\ndescription: Skill wins.\n---\nSKILL',
        },
      ],
    })

    expect(catalog.expandPrompt('/probe').userMessages.at(-1)).toContain(
      'SKILL',
    )
    expect(catalog.modelInvocableSkills().map((item) => item.name)).toEqual([
      'loop',
      'probe',
      'broken',
      'invalid-description',
      'invalid-flag',
    ])
    expect(catalog.expandPrompt('/broken').userMessages.at(-1)).toContain(
      'BROKEN',
    )
    expect(
      catalog.expandPrompt('/invalid-description').userMessages.at(-1),
    ).toContain('INVALID_DESCRIPTION')
    expect(catalog.expandPrompt('/invalid-flag').userMessages.at(-1)).toContain(
      'INVALID_FLAG',
    )
  })

  it('expands the built-in loop command without shared files', () => {
    const catalog = new ClaudeExtensionCatalog({
      agents: [],
      commands: [],
      skills: [],
    })

    const expanded = catalog.expandPrompt('/loop 5m check build').userMessages
    expect(expanded[0]).toBe(
      '<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>5m check build</command-args>',
    )
    expect(expanded[1]).toContain('Input:\n5m check build')
    expect(catalog.skill('loop')?.kind).toBe('command')
  })

  it('disables slash commands while retaining agent definitions', () => {
    const catalog = new ClaudeExtensionCatalog(
      {
        agents: [
          {
            path: '/config/agents/reviewer.md',
            scope: 'user',
            content: '---\nname: reviewer\n---\nREVIEW',
          },
        ],
        commands: [
          {
            path: '/config/commands/check.md',
            scope: 'user',
            content: 'CHECK',
          },
        ],
        skills: [],
      },
      { disableSlashCommands: true },
    )

    expect(catalog.expandPrompt('/check').userMessages).toEqual(['/check'])
    expect(catalog.modelInvocableSkills()).toEqual([])
    expect(catalog.agent('reviewer')?.body).toBe('REVIEW')
  })

  it('uses namespaced command paths, ignores command name metadata, and omits empty args', () => {
    const catalog = new ClaudeExtensionCatalog({
      agents: [],
      skills: [],
      commands: [
        {
          path: '/config/commands/team/probe.md',
          scope: 'user',
          content:
            '---\nname: ignored\ndescription: Namespaced command.\n---\nPROBE',
        },
      ],
    })

    expect(catalog.expandPrompt('/team:probe').userMessages).toEqual([
      '<command-message>team:probe</command-message>\n<command-name>/team:probe</command-name>',
      'PROBE',
    ])
    expect(catalog.expandPrompt('/ignored').userMessages).toEqual(['/ignored'])
  })

  it('expands MCP prompts asynchronously with internal-name precedence and rich content', async () => {
    const calls: string[] = []
    const catalog = new ClaudeExtensionCatalog({
      agents: [],
      skills: [],
      commands: [
        {
          path: '/config/commands/mcp__occupied__prompt.md',
          scope: 'user',
          content: 'LOCAL_WINS',
        },
      ],
    })
    catalog.setMcpPrompts([
      {
        name: 'mcp__occupied__prompt',
        userFacingName: 'occupied:prompt (MCP)',
        description: 'suppressed',
        argumentNames: [],
        invoke: async () => ({ text: 'wrong', contentBlocks: [], images: [] }),
      },
      {
        name: 'mcp__server__prompt.name',
        userFacingName: 'server:prompt.name (MCP)',
        description: 'dynamic',
        argumentNames: ['first', 'second'],
        invoke: async (args, options) => {
          calls.push(args)
          expect(options?.toolResultDirectory).toBe('/session/tool-results')
          return {
            text: 'MCP_BODY',
            contentBlocks: [{ type: 'text', text: 'MCP_BODY' }],
            images: [{ type: 'image', mediaType: 'image/png', data: 'aW1n' }],
          }
        },
      },
    ])

    expect(catalog.mcpPromptNames()).toEqual(['server:prompt.name (MCP)'])
    const expansion = await catalog.expandPromptAsync(
      ' /server:prompt.name (MCP) first  second ',
      undefined,
      '/session/tool-results',
    )
    expect(calls).toEqual(['first  second'])
    expect(expansion.userMessages).toEqual([
      '<command-message>mcp__server__prompt.name</command-message>\n<command-name>/mcp__server__prompt.name</command-name>\n<command-args>first  second</command-args>',
      'MCP_BODY',
    ])
    expect(expansion.messages?.[1]).toMatchObject({
      contentBlocks: [{ type: 'text', text: 'MCP_BODY' }],
      images: [{ type: 'image', mediaType: 'image/png', data: 'aW1n' }],
    })
    await expect(
      catalog.expandPromptAsync('/occupied:prompt (MCP)'),
    ).resolves.toEqual({ userMessages: ['/occupied:prompt (MCP)'] })
  })

  it('exposes every user-invocable slash command with palette metadata', () => {
    const catalog = new ClaudeExtensionCatalog({
      agents: [],
      commands: [
        {
          path: '/config/commands/review.md',
          scope: 'user',
          content: '---\ndescription: Review local changes.\n---\nREVIEW',
        },
      ],
      skills: [
        {
          path: '/config/skills/check/SKILL.md',
          scope: 'user',
          content:
            '---\nname: check\ndescription: Check the workspace.\ndisable-model-invocation: true\n---\nCHECK',
        },
      ],
    })
    catalog.setMcpPrompts([
      {
        name: 'mcp__server__lookup',
        userFacingName: 'server:lookup (MCP)',
        description: 'Look up a shared resource.',
        argumentNames: [],
        invoke: async () => ({ text: '', contentBlocks: [], images: [] }),
      },
    ])

    expect(catalog.slashCommandDefinitions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'loop', kind: 'command' }),
        {
          name: 'review',
          description: 'Review local changes.',
          kind: 'command',
        },
        {
          name: 'check',
          description: 'Check the workspace.',
          kind: 'skill',
        },
        {
          name: 'server:lookup (MCP)',
          description: 'Look up a shared resource.',
          kind: 'mcp',
        },
      ]),
    )
  })

  it('does not expose MCP prompts when slash commands are disabled', async () => {
    const catalog = new ClaudeExtensionCatalog(
      { agents: [], commands: [], skills: [] },
      { disableSlashCommands: true },
    )
    catalog.setMcpPrompts([
      {
        name: 'mcp__server__prompt',
        userFacingName: 'server:prompt (MCP)',
        description: '',
        argumentNames: [],
        invoke: async () => ({ text: 'wrong', contentBlocks: [], images: [] }),
      },
    ])
    expect(catalog.mcpPromptNames()).toEqual([])
    await expect(
      catalog.expandPromptAsync('/server:prompt (MCP)'),
    ).resolves.toEqual({ userMessages: ['/server:prompt (MCP)'] })
  })
})
