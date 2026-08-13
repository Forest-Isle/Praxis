import { describe, expect, it } from 'vitest'

import {
  filterTuiSlashCommands,
  mergeTuiSlashCommands,
  slashCommandQuery,
} from './slash-commands.js'

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
        'background',
        'context',
        'status',
        'theme',
        'skills',
        'tasks',
        'plan',
        'hooks',
      ]),
    )
    expect(commands.find((command) => command.name === 'background')).toEqual({
      name: 'background',
      description: 'Send this session to the background and free the terminal',
      source: 'builtin',
    })
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
