import { describe, expect, it } from 'vitest'

import type { TuiBtwSurfaceModel } from './btw-surface-model.js'
import type { TuiDiffSurfaceModel } from './diff-surface-model.js'
import type { TuiHelpSurfaceModel } from './help-surface-model.js'
import type { TuiListSurfaceModel } from './list-surface-model.js'
import type { TuiMcpServer } from './mcp-panel-projector.js'
import type { TuiMcpSurfaceModel } from './mcp-surface-model.js'
import {
  projectQuietOperationalRows,
  type QuietOperationalProjectionOptions,
} from './quiet-operational-rows.js'
import type { TuiRewindSurfaceModel } from './rewind-surface-model.js'
import type { TuiTaskSurfaceModel } from './task-surface-model.js'

const rowText = (row: { readonly segments: readonly { text: string }[] }) =>
  row.segments.map((segment) => segment.text).join('')
const texts = (rows: ReturnType<typeof projectQuietOperationalRows>) =>
  rows.map(rowText)
const options = (
  overrides: Partial<QuietOperationalProjectionOptions> = {},
): QuietOperationalProjectionOptions => ({
  density: 'standard',
  maxItems: 20,
  ...overrides,
})

function helpCommands(focusedIndex: number): TuiHelpSurfaceModel {
  return {
    kind: 'help',
    title: 'Help',
    invocation: '?',
    tabs: [{ id: 'commands', label: 'Commands', current: true }],
    activeTab: { id: 'commands', label: 'Commands' },
    activeContent: {
      kind: 'commands',
      heading: 'Browse commands',
      commands: Array.from({ length: 5 }, (_, index) => ({
        id: `commands:${index}`,
        ordinal: index + 1,
        invocation: `/cmd${index}`,
        description:
          index === 4 ? 'Run\u001b[31m the final command' : `Command ${index}`,
      })),
      focusedIndex,
      emptyText: 'No commands found.',
    },
    navigation: {
      switchTabs: 'Left/Right to switch tabs',
      browseCommands: 'Up/Down to browse commands',
      close: 'Esc to close',
    },
    documentation: {
      label: 'Praxis documentation',
      url: 'https://github.com/Forest-Isle/Praxis',
    },
  }
}

function mcpServer(
  name: string,
  status: TuiMcpServer['status'],
  tools: TuiMcpServer['tools'] = [],
): TuiMcpServer {
  return {
    name,
    scope: 'project',
    path: `/tmp/${name}.json`,
    location: `/tmp/${name}.json`,
    status,
    statusDetail: status,
    transport: 'stdio',
    command: name,
    args: [],
    capabilities: tools.length ? ['tools'] : [],
    toolCount: tools.length,
    tools,
  }
}

describe('projectQuietOperationalRows', () => {
  it('centers Help commands, bounds shortcuts, and applies density disclosure', () => {
    const minimal = projectQuietOperationalRows(
      helpCommands(4),
      options({ density: 'minimal', maxItems: 2 }),
    )
    expect(texts(minimal)).toContain('❯ /cmd4')
    expect(texts(minimal).some((value) => value.endsWith('—'))).toBe(false)
    expect(minimal.some((row) => row.key === 'quiet:help:documentation')).toBe(
      false,
    )
    expect(
      minimal.some((row) =>
        row.segments.some((segment) => /[\u001b\u009b]/u.test(segment.text)),
      ),
    ).toBe(false)

    const full = projectQuietOperationalRows(
      helpCommands(4),
      options({ density: 'full', maxItems: 2 }),
    )
    expect(texts(full)).toContain('❯ /cmd4 — Run the final command')
    expect(full.some((row) => row.key === 'quiet:help:documentation')).toBe(
      true,
    )

    const general: TuiHelpSurfaceModel = {
      ...helpCommands(0),
      tabs: [{ id: 'general', label: 'General', current: true }],
      activeTab: { id: 'general', label: 'General' },
      activeContent: {
        kind: 'general',
        description: 'General help',
        shortcutGroups: [
          {
            id: 'prompt',
            shortcuts: [
              { id: 'one', key: '1', description: 'first' },
              { id: 'two', key: '2', description: 'second' },
            ],
          },
        ],
      },
    }
    const bounded = projectQuietOperationalRows(
      general,
      options({ maxItems: 1 }),
    )
    expect(
      bounded.filter((row) => row.key.startsWith('quiet:help:shortcut:')),
    ).toHaveLength(1)
  })

  it('projects all densities with secondary descriptions only when spacious', () => {
    const surface: TuiListSurfaceModel = {
      kind: 'list-panel',
      title: 'Agents',
      rows: [{ label: 'build', description: 'Build the project' }],
      emptyText: 'No agents configured',
      selectedIndex: 0,
    }
    for (const density of [
      'full',
      'standard',
      'compact',
      'narrow',
      'minimal',
    ] as const) {
      const projected = texts(
        projectQuietOperationalRows(surface, options({ density })),
      ).join('\n')
      expect(projected.includes('Build the project')).toBe(
        density === 'full' || density === 'standard',
      )
    }
  })

  it('keeps Diff selections visible and preserves all footer actions', () => {
    const surface: TuiDiffSurfaceModel = {
      kind: 'diff',
      title: 'Audit',
      sourceTabs: [
        { id: 'source-0', index: 0, label: 'Current', selected: false },
        { id: 'source-1', index: 1, label: 'T1', selected: false },
        { id: 'source-2', index: 2, label: 'T2', selected: true },
      ],
      currentSource: { index: 2, label: 'T2' },
      view: {
        kind: 'summary',
        totals: { additions: 4, deletions: 2 },
        files: Array.from({ length: 4 }, (_, index) => ({
          id: `file-${index}`,
          path: `src/${index}.ts`,
          additions: index,
          deletions: 0,
        })),
        selectedIndex: 3,
        emptyText: 'No uncommitted changes.',
        actions: [
          {
            visualLabel: '←/→ to switch source',
            screenReaderLabel: 'Use left and right arrows to switch source',
          },
          {
            visualLabel: '↑/↓ to select · Enter to view',
            screenReaderLabel: 'Select a file and press Enter to view',
          },
        ],
        cancellation: {
          visualLabel: 'Esc to close',
          screenReaderLabel: 'Escape to close',
        },
      },
    }
    const projected = projectQuietOperationalRows(
      surface,
      options({ maxItems: 1 }),
    )
    expect(texts(projected)).toContain('❯ T2')
    expect(texts(projected)).toContain('❯ src/3.ts (+3/−0)')
    expect(texts(projected).at(-1)).toBe(
      '←/→ to switch source  ↑/↓ to select · Enter to view  Esc to close',
    )

    const summary = surface.view
    if (summary.kind !== 'summary') throw new Error('expected diff summary')
    const detail: TuiDiffSurfaceModel = {
      ...surface,
      view: {
        kind: 'file-detail',
        file: summary.files[3]!,
        patchRows: [
          { id: 'plus', text: '+added', kind: 'added', absoluteIndex: 1 },
          { id: 'minus', text: '-removed', kind: 'removed', absoluteIndex: 2 },
        ],
        windowSize: 18,
        scrollOffset: 0,
        scrollRange: { min: 0, max: 2 },
        totalLines: 2,
        visibleStart: 1,
        visibleEnd: 2,
        emptyPatchText: 'No patch content.',
        actions: [
          {
            visualLabel: '↑/↓ to scroll',
            screenReaderLabel: 'Use up and down arrows to scroll',
          },
        ],
        cancellation: {
          visualLabel: 'Esc to back',
          screenReaderLabel: 'Escape to go back',
        },
      },
    }
    const detailRows = projectQuietOperationalRows(
      detail,
      options({ maxItems: 2 }),
    )
    expect(
      detailRows.find((row) => row.key.includes('plus'))?.segments[0]?.role,
    ).toBe('diffAdded')
    expect(
      detailRows.find((row) => row.key.includes('minus'))?.segments[0]?.role,
    ).toBe('diffRemoved')
    expect(texts(detailRows).at(-1)).toBe('↑/↓ to scroll  Esc to back')
  })

  it('covers MCP list, detail, tools, tool, and empty states', () => {
    const tools = [
      { name: 'Read', fullName: 'mcp__server__read', description: 'Read data' },
      {
        name: 'Write',
        fullName: 'mcp__server__write',
        description: 'Write data',
      },
    ]
    const model = {
      cwd: '/repo',
      servers: [
        mcpServer('connected', 'connected', tools),
        mcpServer('disabled', 'disabled'),
        mcpServer('broken', 'failed'),
      ],
    }
    const list: TuiMcpSurfaceModel = {
      kind: 'mcp-panel',
      model,
      state: { depth: 'list', serverIndex: 2, selectedIndex: 0 },
    }
    const listRows = projectQuietOperationalRows(
      list,
      options({ maxItems: 1, screenReader: true }),
    )
    const broken = listRows.find((row) => row.key.endsWith(':broken'))
    expect(rowText(broken!)).toContain('Selected: ! broken')
    expect(broken?.segments[0]?.role).toBe('error')
    expect(broken?.accessibleText).toBe('Selected: broken, failed')

    const detail: TuiMcpSurfaceModel = {
      ...list,
      state: { depth: 'detail', serverIndex: 0, selectedIndex: 2 },
    }
    expect(
      texts(projectQuietOperationalRows(detail, options({ maxItems: 1 }))),
    ).toContain('❯ Disable')

    const toolList: TuiMcpSurfaceModel = {
      ...list,
      state: { depth: 'tools', serverIndex: 0, selectedIndex: 1 },
    }
    expect(
      texts(projectQuietOperationalRows(toolList, options({ maxItems: 1 }))),
    ).toContain('❯ Write')

    const toolDetail: TuiMcpSurfaceModel = {
      ...list,
      state: { depth: 'tool', serverIndex: 0, selectedIndex: 1 },
    }
    expect(texts(projectQuietOperationalRows(toolDetail, options()))).toContain(
      'Write data',
    )
    const noTool: TuiMcpSurfaceModel = {
      ...list,
      state: { depth: 'tool', serverIndex: 1, selectedIndex: 0 },
    }
    expect(texts(projectQuietOperationalRows(noTool, options()))).toContain(
      'No tool selected.',
    )
  })

  it('centers Tasks, reaches late output, validates time, and bounds truncation', () => {
    const surface: TuiTaskSurfaceModel = {
      kind: 'tasks-panel',
      tasks: [
        {
          id: 'one',
          kind: 'shell',
          status: 'completed',
          label: 'one',
          createdAtMs: 1,
        },
        {
          id: 'two',
          kind: 'agent',
          status: 'running',
          label: 'two',
          createdAtMs: 2,
        },
        {
          id: 'three',
          kind: 'workflow',
          status: 'failed',
          label: 'three',
          output: 'failed',
          createdAtMs: 3,
        },
      ],
      state: { depth: 'list', selectedIndex: 2, scrollOffset: 0 },
    }
    const listRows = projectQuietOperationalRows(
      surface,
      options({ maxItems: 1, screenReader: true }),
    )
    const selected = listRows.find((row) => row.key === 'quiet:task:three')
    expect(rowText(selected!)).toContain('Selected: ! workflow · failed')
    expect(selected?.segments[0]?.role).toBe('error')

    const detail: TuiTaskSurfaceModel = {
      kind: 'tasks-panel',
      tasks: [
        {
          id: 'running',
          kind: 'shell',
          status: 'running',
          label: 'run tests',
          command: 'npm test',
          output: 'line-0\nline-1\nline-2\nline-3\nline-4\nline-5',
          startedAtMs: 1_000,
          createdAtMs: 1_000,
        },
      ],
      state: { depth: 'detail', selectedIndex: 0, scrollOffset: 4 },
    }
    const detailRows = projectQuietOperationalRows(
      detail,
      options({ maxItems: 2, nowMs: 7_000 }),
    )
    expect(texts(detailRows)).toContain('Duration: 6 seconds')
    expect(texts(detailRows)).toContain('line-4')
    expect(texts(detailRows)).toContain('line-5')
    expect(texts(detailRows)).not.toContain('line-0')
    expect(
      texts(
        projectQuietOperationalRows(
          detail,
          options({ maxItems: 2, nowMs: Number.POSITIVE_INFINITY }),
        ),
      ).some((value) => value.startsWith('Duration:')),
    ).toBe(false)

    const huge: TuiTaskSurfaceModel = {
      ...detail,
      tasks: [{ ...detail.tasks[0]!, output: 'x'.repeat(40_000) }],
      state: { depth: 'detail', selectedIndex: 0, scrollOffset: 0 },
    }
    const hugeRows = projectQuietOperationalRows(huge, options({ maxItems: 2 }))
    expect(texts(hugeRows)).toContain('Output truncated.')
    expect(hugeRows.filter((row) => row.key.includes(':output:'))).toHaveLength(
      1,
    )
  })

  it('preserves generic-list keys across selection and label reordering', () => {
    const make = (
      rows: TuiListSurfaceModel['rows'],
      selectedIndex: number,
    ): TuiListSurfaceModel => ({
      kind: 'list-panel',
      title: 'Agents',
      rows,
      emptyText: 'No agents configured',
      selectedIndex,
    })
    const alpha = { label: 'alpha', description: 'Alpha agent' }
    const beta = { label: 'beta', description: 'Beta agent' }
    const first = projectQuietOperationalRows(make([alpha, beta], 0), options())
    const second = projectQuietOperationalRows(
      make([beta, alpha], 1),
      options(),
    )
    expect(first.find((row) => rowText(row).includes('alpha'))?.key).toBe(
      second.find((row) => rowText(row).includes('alpha'))?.key,
    )

    const duplicates = projectQuietOperationalRows(
      make([{ label: 'same' }, { label: 'same' }], 1),
      options(),
    ).filter((row) => row.key.startsWith('quiet:list:['))
    expect(new Set(duplicates.map((row) => row.key)).size).toBe(2)
    expect(
      texts(
        projectQuietOperationalRows(
          make([alpha, beta], 1),
          options({ maxItems: 1 }),
        ),
      ),
    ).toContain('❯ beta — Beta agent')
  })

  it('keeps selected BTW visible and discloses failures at minimal density', () => {
    const entries: TuiBtwSurfaceModel['entries'] = Array.from(
      { length: 5 },
      (_, index) => ({
        id: index,
        question: `question-${index}`,
        answer: index === 4 ? '' : `answer-${index}`,
        status: index === 4 ? 'error' : 'complete',
        ...(index === 4 ? { error: 'provider unavailable' } : {}),
      }),
    )
    const surface: TuiBtwSurfaceModel = {
      kind: 'btw-panel',
      entries,
      selectedIndex: 4,
      scrollOffset: 0,
      copied: true,
    }
    const rows = projectQuietOperationalRows(
      surface,
      options({ density: 'minimal', maxItems: 2, screenReader: true }),
    )
    expect(texts(rows).some((value) => value.includes('question-4'))).toBe(true)
    expect(texts(rows)).toContain('Error: provider unavailable')
    expect(texts(rows)).toContain('Copied.')
    expect(
      rows.find((row) => row.key === 'quiet:btw:4')?.segments[0]?.role,
    ).toBe('error')
  })

  it('bounds and centers every Rewind view with warning semantics', () => {
    const points = Array.from({ length: 5 }, (_, index) => ({
      messageId: `point-${index}`,
      prompt: `prompt-${index}`,
      fileChanges: [],
      fileRestoreAvailable: false,
    }))
    const pointSurface: TuiRewindSurfaceModel = {
      kind: 'rewind-panel',
      view: 'points',
      points,
      selectedIndex: 4,
      window: { start: 0, end: 5 },
    }
    expect(
      texts(
        projectQuietOperationalRows(pointSurface, options({ maxItems: 1 })),
      ),
    ).toContain('❯ prompt-4')

    const empty: TuiRewindSurfaceModel = {
      ...pointSurface,
      points: [],
      selectedIndex: 0,
      window: { start: 0, end: 0 },
    }
    expect(texts(projectQuietOperationalRows(empty, options()))).toContain(
      'No rewind points.',
    )

    const confirm: TuiRewindSurfaceModel = {
      kind: 'rewind-panel',
      view: 'confirm',
      points,
      point: points[0]!,
      selectedIndex: 0,
      actions: [
        { action: 'conversation', label: 'Restore conversation' },
        { action: 'summarize-from', label: 'Summarize from here' },
        { action: 'cancel', label: 'Never mind' },
      ],
    }
    const confirmRows = projectQuietOperationalRows(
      confirm,
      options({ maxItems: 1 }),
    )
    const restore = confirmRows.find((row) => row.key.endsWith(':conversation'))
    expect(rowText(restore!)).toBe('❯ Restore conversation')
    expect(restore?.segments[0]?.role).toBe('warning')

    const cancelRows = projectQuietOperationalRows(
      { ...confirm, selectedIndex: 2 },
      options({ maxItems: 1 }),
    )
    expect(texts(cancelRows)).toContain('❯ Never mind')

    const context: TuiRewindSurfaceModel = {
      kind: 'rewind-panel',
      view: 'context',
      points,
      point: points[0]!,
      direction: 'from',
      context: 'oldest\nmiddle\nnewest',
    }
    const contextRows = projectQuietOperationalRows(
      context,
      options({ maxItems: 2 }),
    )
    expect(texts(contextRows)).toContain('oldest')
    expect(texts(contextRows)).toContain('Context truncated.')
    expect(
      contextRows.filter((row) => row.key.startsWith('quiet:rewind:context:')),
    ).toHaveLength(2)
  })
})
