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
})
