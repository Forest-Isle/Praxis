import { describe, expect, it } from 'vitest'
import type { DoctorReport } from '../../maintenance/doctor.js'
import type { TuiHooksSurfaceModel } from './hooks-surface-model.js'
import type { TuiMemorySurfaceModel } from './memory-surface-model.js'
import type { TuiSandboxSurfaceModel } from './sandbox-surface-model.js'
import {
  projectQuietSettingsRows,
  type QuietSettingsSurface,
} from './quiet-settings-rows.js'

const options = {
  density: 'standard' as const,
  maxItems: 2,
  screenReader: true,
}
const project = (surface: unknown) =>
  projectQuietSettingsRows(surface as QuietSettingsSurface, options)
const text = (rows: readonly { segments: readonly { text: string }[] }[]) =>
  rows.map((r) => r.segments.map((s) => s.text).join(' ')).join('\n')

describe('quiet settings rows', () => {
  it('projects every top-level surface and nested leaf', () => {
    const surfaces: unknown[] = [
      { kind: 'doctor-panel', loading: true, report: null, error: null },
      {
        kind: 'memory-panel',
        autoMemoryEnabled: false,
        entries: [],
        selectedIndex: 0,
        openedIndex: null,
        loading: false,
        dataPlane: 'native',
      },
      {
        kind: 'hooks-panel',
        configuration: { events: [] },
        depth: 'events',
        eventIndex: 0,
        matcherIndex: 0,
        hookIndex: 0,
      },
      {
        kind: 'config-panel',
        tab: 'status',
        snapshot: { settings: {}, state: {} },
        query: '',
        selectedIndex: 0,
        searchFocused: true,
      },
      {
        kind: 'sandbox-panel',
        tab: 'mode',
        selectedIndex: 0,
        snapshot: {
          settings: {
            enabled: false,
            failIfUnavailable: false,
            autoAllowBashIfSandboxed: true,
            allowUnsandboxedCommands: true,
            excludedCommands: [],
            runtimeConfig: {},
          },
          dependencies: { errors: [], warnings: [] },
          supported: true,
          platform: 'linux',
        },
      },
      {
        kind: 'model-panel',
        options: [{ label: 'Sonnet', description: '', model: 'sonnet' }],
        effort: 'high',
        selectedIndex: 0,
      },
      {
        kind: 'effort-panel',
        options: [{ label: 'high', description: '' }],
        selectedIndex: 0,
      },
      {
        kind: 'theme-panel',
        currentTheme: 'auto',
        options: [{ id: 'auto', label: 'Auto', current: true }],
        selectedIndex: 0,
        syntaxHighlightingDisabled: true,
      },
      { kind: 'custom-theme-create', base: 'dark', name: '' },
      {
        kind: 'custom-theme-editor',
        theme: { name: 'X', slug: 'x', base: 'dark', overrides: {} },
        tokens: ['text'],
        selectedIndex: 0,
        query: '',
      },
      {
        kind: 'custom-theme-token',
        theme: { name: 'X', slug: 'x', base: 'dark', overrides: {} },
        token: 'text',
        value: '',
      },
      {
        kind: 'custom-theme-delete',
        theme: { name: 'X', slug: 'x', base: 'dark', overrides: {} },
        selectedIndex: 0,
      },
      { kind: 'model-input', value: 'sonnet' },
      { kind: 'export', options: [], selectedIndex: 0 },
      { kind: 'copy', options: [], selectedIndex: 0, messageAge: 1 },
      { kind: 'export-filename', value: 'x.md' },
      { kind: 'compact-progress', progress: 40 },
    ]
    for (const surface of surfaces)
      expect(project(surface).length).toBeGreaterThan(0)
  })

  it('centers bounded selections, sanitizes text, and preserves accessibility', () => {
    const surface = {
      kind: 'model-panel',
      effort: 'high',
      selectedIndex: 3,
      options: Array.from({ length: 8 }, (_, i) => ({
        label: `M${i}`,
        description: '\u001b[31m' + 'x'.repeat(40000),
        model: `m${i}`,
      })),
    }
    const rows = project(surface)
    expect(rows.length).toBeLessThanOrEqual(5)
    expect(text(rows)).toContain('Selected:')
    expect(text(rows)).not.toContain('\u001b')
  })

  it('keeps failures visible at minimal density and handles malformed usage', () => {
    const rows = projectQuietSettingsRows(
      { kind: 'doctor-panel', loading: false, error: 'bad', report: null },
      { density: 'minimal', maxItems: 2 },
    )
    expect(text(rows)).toContain('bad')
    const usage = projectQuietSettingsRows(
      {
        kind: 'config-panel',
        tab: 'usage',
        snapshot: { settings: {}, state: {} },
        query: '',
        selectedIndex: 0,
        searchFocused: false,
        usage: null as never,
      },
      options,
    )
    expect(usage.length).toBeGreaterThan(0)
  })

  it('prioritizes Doctor failures, bounds checks, and always exposes close', () => {
    const report = {
      type: 'doctor',
      ok: false,
      praxisVersion: '1.2.3',
      diagnostic: {},
      updates: {},
      summary: { passed: 2, warnings: 1, failed: 1 },
      checks: [
        { id: 'node', status: 'pass', summary: 'Node is ready' },
        { id: 'settings', status: 'pass', summary: 'Settings are valid' },
        { id: 'hooks', status: 'warn', summary: 'Hook needs attention' },
        { id: 'provider', status: 'fail', summary: 'Provider unavailable' },
      ],
    } as unknown as DoctorReport
    const rows = projectQuietSettingsRows(
      { kind: 'doctor-panel', loading: false, report, error: null },
      { density: 'minimal', maxItems: 2 },
    )
    const projected = text(rows)
    expect(projected).toContain('Provider unavailable')
    expect(projected).toContain('Hook needs attention')
    expect(projected).not.toContain('Node is ready')
    expect(projected).toContain('Esc close')

    const empty = projectQuietSettingsRows(
      { kind: 'doctor-panel', loading: true, report: null, error: null },
      { density: 'standard' },
    )
    expect(text(empty)).toContain('Running diagnostics')
    expect(text(empty)).toContain('Esc close')
  })

  it('centers Memory entries and covers detail and empty states', () => {
    const entries: TuiMemorySurfaceModel['entries'] = Array.from(
      { length: 4 },
      (_, index) => ({
        kind: index === 3 ? 'folder' : 'file',
        label: `memory-${index}`,
        path: `/memory/${index}`,
        displayPath: `./memory/${index}`,
        annotation: `annotation-${index}`,
        scope: 'project',
      }),
    )
    const list: TuiMemorySurfaceModel = {
      kind: 'memory-panel',
      autoMemoryEnabled: true,
      entries,
      selectedIndex: 3,
      openedIndex: null,
      loading: false,
      dataPlane: 'native',
    }
    const listRows = projectQuietSettingsRows(list, {
      density: 'compact',
      maxItems: 1,
      screenReader: true,
    })
    expect(text(listRows)).toContain('Memory · Native data plane')
    expect(text(listRows)).toContain('Selected: Folder · memory-3')
    expect(text(listRows)).not.toContain('annotation-3')

    const detailRows = projectQuietSettingsRows(
      { ...list, openedIndex: 3 },
      { density: 'full', maxItems: 1 },
    )
    expect(text(detailRows)).toContain('Folder · ./memory/3')
    expect(text(detailRows)).toContain('annotation-3')
    expect(text(detailRows)).toContain('Esc back')

    const emptyRows = projectQuietSettingsRows(
      { ...list, entries: [], selectedIndex: 0 },
      { density: 'minimal' },
    )
    expect(text(emptyRows)).toContain('No memory entries')
    expect(text(emptyRows)).toContain('Esc close')
  })

  it('centers every Hooks depth and renders stable detail and empty rows', () => {
    const events: TuiHooksSurfaceModel['configuration']['events'] = Array.from(
      { length: 3 },
      (_, eventIndex) => ({
        name: `Event${eventIndex}`,
        description: `Description ${eventIndex}`,
        detail: [`Detail ${eventIndex}`],
        matchers: Array.from({ length: 3 }, (_, matcherIndex) => ({
          matcher: `Matcher${matcherIndex}`,
          scope: 'project',
          scopeLabel: 'Project',
          hooks: Array.from({ length: 3 }, (_, hookIndex) => ({
            type: 'command',
            label: `Hook${hookIndex}`,
            scopeLabel: 'Project',
            path: `/hooks/${eventIndex}/${matcherIndex}/${hookIndex}`,
          })),
        })),
      }),
    )
    const base: TuiHooksSurfaceModel = {
      kind: 'hooks-panel',
      configuration: { events, hookCount: 27 },
      depth: 'events',
      eventIndex: 2,
      matcherIndex: 2,
      hookIndex: 2,
    }
    expect(
      text(
        projectQuietSettingsRows(base, {
          density: 'standard',
          maxItems: 1,
        }),
      ),
    ).toContain('❯ Event2')
    expect(
      text(
        projectQuietSettingsRows(
          { ...base, depth: 'matchers' },
          { density: 'compact', maxItems: 1 },
        ),
      ),
    ).toContain('❯ Project: Matcher2')
    expect(
      text(
        projectQuietSettingsRows(
          { ...base, depth: 'hooks' },
          { density: 'compact', maxItems: 1 },
        ),
      ),
    ).toContain('/hooks/2/2/2')
    expect(
      text(
        projectQuietSettingsRows(
          { ...base, depth: 'detail' },
          { density: 'full', maxItems: 1 },
        ),
      ),
    ).toContain('Hook · command')

    const empty = projectQuietSettingsRows(
      { ...base, configuration: { events: [], hookCount: 0 } },
      { density: 'minimal' },
    )
    expect(text(empty)).toContain('No hooks configured')
    expect(text(empty)).toContain('Esc close')
  })

  it('covers Config status, settings search, bounded usage, and invalid usage', () => {
    const base = {
      kind: 'config-panel' as const,
      snapshot: { settings: {}, state: {} },
      query: '',
      selectedIndex: 999,
      searchFocused: true,
    }
    const missing = projectQuietSettingsRows(
      { ...base, tab: 'status' },
      { density: 'minimal', maxItems: 1 },
    )
    expect(text(missing)).toContain('Settings · Status')
    expect(text(missing)).toContain('[Status]')
    expect(text(missing)).toContain('Esc close')

    const configRows = projectQuietSettingsRows(
      { ...base, tab: 'config' },
      { density: 'standard', maxItems: 1, screenReader: true },
    )
    expect(
      configRows.filter((row) => row.key.startsWith('quiet:config:setting:')),
    ).toHaveLength(1)
    expect(text(configRows)).toContain('Selected:')
    expect(
      configRows.find((row) => row.key === 'quiet:config:search')?.segments[0]
        ?.role,
    ).toBe('input')

    const usage = {
      totalCostUsd: 1,
      apiDurationMs: 100,
      wallDurationMs: 200,
      linesAdded: 3,
      linesRemoved: 1,
      hasUnknownModelCost: false,
      modelUsage: [],
    }
    const usageRows = projectQuietSettingsRows(
      { ...base, tab: 'usage', usage },
      { density: 'standard', maxItems: 2 },
    )
    expect(
      usageRows.filter((row) => row.key.startsWith('quiet:config:usage:')),
    ).toHaveLength(2)
    expect(text(usageRows)).toContain('Usage truncated')

    const invalidRows = projectQuietSettingsRows(
      {
        ...base,
        tab: 'usage',
        usage: { ...usage, totalCostUsd: -1 },
      },
      { density: 'minimal', maxItems: 2 },
    )
    expect(text(invalidRows)).toContain('Usage summary unavailable')
  })

  it('covers every Sandbox tab with bounds, status, and accessibility', () => {
    const snapshot: TuiSandboxSurfaceModel['snapshot'] = {
      settings: {
        enabled: false,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: false,
        excludedCommands: ['git'],
        runtimeConfig: {
          filesystem: {
            allowWrite: ['.'],
            denyWrite: [],
            allowRead: [],
            denyRead: ['/secret'],
          },
          network: { allowedDomains: [], deniedDomains: ['example.com'] },
        },
      },
      dependencies: {
        errors: ['missing bwrap'],
        warnings: ['seccomp unavailable'],
      },
      supported: false,
      platform: 'linux',
      unavailableReason: 'runtime unavailable',
      globPatternWarnings: ['Read(/secret/*.json)'],
    }
    const mode = projectQuietSettingsRows(
      {
        kind: 'sandbox-panel',
        snapshot,
        tab: 'mode',
        selectedIndex: 2,
      },
      { density: 'minimal', maxItems: 1, screenReader: true },
    )
    expect(text(mode)).toContain('Selected: Disabled (current)')
    expect(text(mode)).toContain('runtime unavailable')

    const dependencies = projectQuietSettingsRows(
      {
        kind: 'sandbox-panel',
        snapshot,
        tab: 'dependencies',
        selectedIndex: 0,
      },
      { density: 'minimal', maxItems: 1 },
    )
    expect(text(dependencies)).toContain('missing bwrap')
    expect(text(dependencies)).not.toContain('Sandbox dependencies ready')

    const { unavailableReason: _unavailableReason, ...availableSnapshot } =
      snapshot
    const ready = projectQuietSettingsRows(
      {
        kind: 'sandbox-panel',
        snapshot: {
          ...availableSnapshot,
          supported: true,
          dependencies: { errors: [], warnings: [] },
        },
        tab: 'dependencies',
        selectedIndex: 0,
      },
      { density: 'minimal', maxItems: 1 },
    )
    expect(text(ready)).toContain('Sandbox dependencies ready')

    const overrides = projectQuietSettingsRows(
      {
        kind: 'sandbox-panel',
        snapshot,
        tab: 'overrides',
        selectedIndex: 1,
      },
      { density: 'compact', maxItems: 1 },
    )
    expect(text(overrides)).toContain('❯ Strict sandbox mode (current)')

    const config = projectQuietSettingsRows(
      {
        kind: 'sandbox-panel',
        snapshot,
        tab: 'config',
        selectedIndex: 0,
      },
      { density: 'minimal', maxItems: 1 },
    )
    expect(text(config)).toContain('Glob warning')
    expect(config.some((row) => row.key.includes('allow write'))).toBe(false)
    expect(text(config)).toContain('Esc close')
  })

  it('keeps model, effort, and theme option keys stable and density-aware', () => {
    const model = (reverse: boolean) => ({
      kind: 'model-panel' as const,
      options: reverse
        ? [
            { label: 'Beta', description: 'Beta model', model: 'beta' },
            { label: 'Alpha', description: 'Alpha model', model: 'alpha' },
          ]
        : [
            { label: 'Alpha', description: 'Alpha model', model: 'alpha' },
            { label: 'Beta', description: 'Beta model', model: 'beta' },
          ],
      effort: 'high',
      selectedIndex: reverse ? 1 : 0,
    })
    const first = projectQuietSettingsRows(model(false), {
      density: 'standard',
    })
    const second = projectQuietSettingsRows(model(true), {
      density: 'standard',
    })
    expect(first.find((row) => text([row]).includes('Alpha'))?.key).toBe(
      second.find((row) => text([row]).includes('Alpha'))?.key,
    )

    for (const density of [
      'full',
      'standard',
      'compact',
      'narrow',
      'minimal',
    ] as const) {
      const projected = text(
        projectQuietSettingsRows(model(false), { density }),
      )
      expect(projected.includes('Alpha model')).toBe(
        density === 'full' || density === 'standard',
      )
    }

    const effort = projectQuietSettingsRows(
      {
        kind: 'effort-panel',
        options: [
          { label: 'low', description: 'Fast' },
          { label: 'high', description: 'Deep' },
        ],
        selectedIndex: 1,
      },
      { density: 'compact', maxItems: 1 },
    )
    expect(text(effort)).toContain('❯ high')

    const theme = {
      name: 'Quiet',
      slug: 'quiet',
      base: 'dark' as const,
      overrides: { text: '#ffffff' },
    }
    const themePanel = projectQuietSettingsRows(
      {
        kind: 'theme-panel',
        currentTheme: 'dark',
        options: [
          { id: 'auto', label: 'Auto', current: false },
          { id: 'dark', label: 'Dark', current: true },
        ],
        selectedIndex: 1,
        syntaxHighlightingDisabled: false,
      },
      { density: 'compact', maxItems: 1 },
    )
    expect(text(themePanel)).toContain('❯ Dark (current)')
    expect(themePanel.some((row) => row.key.includes('dark'))).toBe(true)
    expect(
      text(
        projectQuietSettingsRows(
          { kind: 'custom-theme-create', base: 'dark', name: 'Quiet' },
          { density: 'standard' },
        ),
      ),
    ).toContain('Name: Quiet')
    expect(
      text(
        projectQuietSettingsRows(
          {
            kind: 'custom-theme-editor',
            theme,
            tokens: ['text', 'warning'],
            selectedIndex: 1,
            query: '',
          },
          { density: 'compact', maxItems: 1 },
        ),
      ),
    ).toContain('❯ warning')
    expect(
      text(
        projectQuietSettingsRows(
          {
            kind: 'custom-theme-token',
            theme,
            token: 'text',
            value: '#000000',
          },
          { density: 'standard' },
        ),
      ),
    ).toContain('Value: #000000')
    const deletion = projectQuietSettingsRows(
      { kind: 'custom-theme-delete', theme, selectedIndex: 0 },
      { density: 'full' },
    )
    expect(
      deletion.find((row) => text([row]).includes('Delete theme'))?.segments[0]
        ?.role,
    ).toBe('error')
  })

  it('covers every leaf view, intrinsic option IDs, progress roles, and bounds', () => {
    const input = projectQuietSettingsRows(
      { kind: 'model-input', value: `sonnet\u001b[31m${'x'.repeat(40_000)}` },
      { density: 'minimal' },
    )
    expect(text(input)).not.toContain('\u001b')
    expect(text(input).length).toBeLessThan(600)

    const exportRows = projectQuietSettingsRows(
      {
        kind: 'export',
        options: [
          { id: 'clipboard', label: 'Clipboard', description: 'Copy' },
          { id: 'file', label: 'File', description: 'Save' },
        ],
        selectedIndex: 1,
      },
      { density: 'compact', maxItems: 1 },
    )
    expect(text(exportRows)).toContain('❯ File')
    expect(exportRows.some((row) => row.key.includes('file'))).toBe(true)

    const copy = {
      kind: 'copy' as const,
      options: [{ id: 'assistant', label: 'Assistant', description: 'Latest' }],
      selectedIndex: 0,
      messageAge: 7,
    }
    expect(text(projectQuietSettingsRows(copy, { density: 'full' }))).toContain(
      'Message age: 7',
    )
    expect(
      text(projectQuietSettingsRows(copy, { density: 'minimal' })),
    ).not.toContain('Message age')
    expect(
      text(
        projectQuietSettingsRows(
          { kind: 'export-filename', value: 'conversation.md' },
          { density: 'minimal' },
        ),
      ),
    ).toContain('conversation.md')

    const running = projectQuietSettingsRows(
      { kind: 'compact-progress', progress: 40 },
      { density: 'minimal' },
    )
    expect(text(running)).toContain('Compaction progress')
    expect(running.at(-1)?.segments[0]?.role).toBe('warning')
    const complete = projectQuietSettingsRows(
      { kind: 'compact-progress', progress: 100 },
      { density: 'minimal' },
    )
    expect(complete.at(-1)?.segments[0]?.role).toBe('success')
  })
})
