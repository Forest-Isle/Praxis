import { describe, expect, it } from 'vitest'

import { editNotebook, formatNotebookForRead } from './notebook.js'

function notebook(cells: unknown[]): string {
  return JSON.stringify({ cells, metadata: { retained: true }, nbformat: 4 })
}

describe('notebook tools', () => {
  it('formats cell IDs, sources, and text outputs for Read', () => {
    expect(
      formatNotebookForRead(
        notebook([
          {
            cell_type: 'markdown',
            metadata: {},
            source: ['# Title\n', 'body'],
          },
          {
            cell_type: 'code',
            id: 'code-1',
            metadata: {},
            outputs: [{ text: ['value\n'] }],
            source: 'print(1)',
          },
        ]),
      ),
    ).toBe(
      '<cell id="cell-0"><cell_type>markdown</cell_type># Title\nbody</cell id="cell-0">\n' +
        '<cell id="code-1">print(1)</cell id="code-1">\n\nvalue\n',
    )
  })

  it('replaces, inserts, and deletes one cell while preserving metadata', () => {
    const source = notebook([
      {
        cell_type: 'markdown',
        id: 'intro',
        metadata: { tag: 'keep' },
        source: 'old',
      },
      {
        cell_type: 'code',
        execution_count: 4,
        id: 'code-1',
        metadata: {},
        outputs: [{ text: 'keep output' }],
        source: 'old code',
      },
    ])
    const replaced = editNotebook(source, {
      cellId: 'intro',
      editMode: 'replace',
      newSource: 'new',
    })
    expect(replaced.content).toBe('Updated cell intro with new')
    expect(JSON.parse(replaced.source)).toMatchObject({
      cells: [
        { id: 'intro', metadata: { tag: 'keep' }, source: 'new' },
        {
          id: 'code-1',
          execution_count: 4,
          outputs: [{ text: 'keep output' }],
        },
      ],
      metadata: { retained: true },
    })

    const inserted = editNotebook(replaced.source, {
      cellId: 'intro',
      cellType: 'code',
      editMode: 'insert',
      newSource: 'print(2)',
    })
    const insertedDocument = JSON.parse(inserted.source)
    expect(insertedDocument.cells[1]).toMatchObject({
      cell_type: 'code',
      execution_count: null,
      id: expect.stringMatching(/^[0-9a-f]{8}$/),
      metadata: {},
      outputs: [],
      source: 'print(2)',
    })

    const deleted = editNotebook(inserted.source, {
      cellId: 'code-1',
      editMode: 'delete',
      newSource: '',
    })
    expect(deleted.content).toBe('Deleted cell code-1')
    expect(JSON.parse(deleted.source).cells).toHaveLength(2)
  })

  it('rejects malformed notebooks, missing cells, and incomplete edits', () => {
    expect(() => formatNotebookForRead('{')).toThrow('not valid JSON')
    expect(() => formatNotebookForRead('{}')).toThrow('cells array')
    expect(() =>
      editNotebook(notebook([]), {
        cellId: 'missing',
        editMode: 'replace',
        newSource: 'new',
      }),
    ).toThrow('Cell missing was not found')
    expect(() =>
      editNotebook(notebook([]), {
        editMode: 'insert',
        newSource: 'new',
      }),
    ).toThrow('cell_type is required')
  })
})
