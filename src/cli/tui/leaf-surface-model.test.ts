import { describe, expect, it } from 'vitest'

import { projectTuiLeafSurface } from './leaf-surface-model.js'

describe('projectTuiLeafSurface', () => {
  it('projects model and filename input without changing empty values', () => {
    expect(projectTuiLeafSurface({ kind: 'model-input', value: '' })).toEqual({
      kind: 'model-input',
      value: '',
    })
    expect(
      projectTuiLeafSurface({ kind: 'export-filename', value: 'custom.txt' }),
    ).toEqual({ kind: 'export-filename', value: 'custom.txt' })
  })

  it('projects fixed export options and clamps selection', () => {
    const surface = projectTuiLeafSurface({ kind: 'export', selectedIndex: 9 })
    expect(surface.options.map((option) => option.id)).toEqual([
      'clipboard',
      'file',
    ])
    expect(surface.selectedIndex).toBe(1)
  })

  it('redacts copy content while retaining ordered semantic presentation', () => {
    const surface = projectTuiLeafSurface({
      kind: 'copy',
      candidates: [
        {
          kind: 'full',
          label: 'Full response',
          description: '2 chars, 1 lines',
          text: 'secret',
          filename: 'response.md',
        },
        {
          kind: 'code',
          label: 'answer',
          description: 'ts',
          text: 'secret code',
          filename: 'copy.ts',
        },
      ],
      selectedIndex: -1,
      messageAge: 2,
    })
    expect(surface).toMatchObject({ selectedIndex: 0, messageAge: 2 })
    expect(surface.options).toEqual([
      {
        id: 'copy-full-0',
        label: 'Full response',
        description: '2 chars, 1 lines',
      },
      { id: 'copy-code-1', label: 'answer', description: 'ts' },
    ])
    expect(JSON.stringify(surface)).not.toContain('secret')
    expect(JSON.stringify(surface)).not.toContain('response.md')
  })

  it('clamps compact progress to the display range', () => {
    expect(
      projectTuiLeafSurface({ kind: 'compact-progress', progress: -10 }),
    ).toEqual({ kind: 'compact-progress', progress: 0 })
    expect(
      projectTuiLeafSurface({ kind: 'compact-progress', progress: 120 }),
    ).toEqual({ kind: 'compact-progress', progress: 100 })
  })
})
