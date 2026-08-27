import { describe, expect, it } from 'vitest'

import {
  filterTuiSlashCommands,
  mergeTuiSlashCommands,
  slashCommandQuery,
} from './slash-commands.js'
import { CLAUDE_2_1_208_COMMAND_BY_NAME } from './claude-command-inventory.js'

describe('TUI slash command catalog', () => {
  it('keeps built-ins authoritative and normalizes extension names', () => {
    const commands = mergeTuiSlashCommands([
      {
        name: '/resume',
        description: 'Should not replace the local command.',
        source: 'command',
      },
      {
        name: '/review',
        description: 'Review the current change.',
        source: 'skill',
      },
    ])

    expect(commands.find((command) => command.name === 'resume')).toMatchObject(
      {
        source: 'builtin',
        description: 'Resume a previous conversation',
      },
    )
    expect(commands.find((command) => command.name === 'review')).toEqual({
      name: 'review',
      description: 'Review the current change.',
      source: 'skill',
    })
    expect(commands.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'agents',
        'color',
        'context',
        'status',
        'theme',
        'vim',
        'skills',
        'tasks',
        'plan',
        'hooks',
      ]),
    )
    expect(commands.find((command) => command.name === 'color')).toEqual({
      name: 'color',
      description: 'Set the prompt bar color for this session',
      argumentHint: '[red|blue|green|yellow|purple|orange|pink|cyan|default]',
      source: 'builtin',
    })
    expect(commands.find((command) => command.name === 'agents')).toEqual({
      name: 'agents',
      description:
        '(removed) Ask Praxis to create/manage subagents, or edit .praxis/agents/',
      source: 'builtin',
    })
    for (const command of commands.filter(
      (candidate) => candidate.source === 'builtin',
    )) {
      const inventory = CLAUDE_2_1_208_COMMAND_BY_NAME.get(command.name)
      expect(
        inventory,
        `/${command.name} must come from the Claude 2.1.208 source registry`,
      ).toBeDefined()
      expect(['included', 'required']).toContain(inventory?.disposition)
    }
    expect(
      commands.find((command) => command.name === 'output-style'),
    ).toBeUndefined()
  })

  it('filters a palette query until the user starts command arguments', () => {
    const commands = mergeTuiSlashCommands([
      {
        name: 'review',
        description: 'Review a pull request.',
        source: 'command',
      },
      {
        name: 'server:lookup (MCP)',
        description: 'Look up a shared resource.',
        source: 'mcp',
      },
    ])

    expect(slashCommandQuery('/rev')).toBe('rev')
    expect(slashCommandQuery('/review src')).toBeNull()
    expect(
      filterTuiSlashCommands(commands, 'rev').map(({ name }) => name),
    ).toEqual(['review', 'clear', 'resume'])
    expect(
      filterTuiSlashCommands(commands, 'resource').map(({ name }) => name),
    ).toEqual(['server:lookup (MCP)'])
    expect(
      filterTuiSlashCommands(commands, '').map(({ name }) => name),
    ).toEqual([...commands].map(({ name }) => name).sort())
  })
})
