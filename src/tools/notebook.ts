import { randomBytes } from 'node:crypto'

interface NotebookCell extends Record<string, unknown> {
  cell_type: string
  source: string | string[]
}

interface NotebookDocument extends Record<string, unknown> {
  cells: NotebookCell[]
}

export interface NotebookEditInput {
  cellId?: string
  cellType?: 'code' | 'markdown'
  editMode: 'replace' | 'insert' | 'delete'
  newSource: string
}

export interface NotebookEditResult {
  content: string
  source: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCell(value: unknown, index: number): NotebookCell {
  if (!isRecord(value)) throw new Error(`Notebook cell ${index} is invalid`)
  if (typeof value.cell_type !== 'string') {
    throw new Error(`Notebook cell ${index} has no cell_type`)
  }
  if (
    typeof value.source !== 'string' &&
    (!Array.isArray(value.source) ||
      !value.source.every((line) => typeof line === 'string'))
  ) {
    throw new Error(`Notebook cell ${index} has invalid source`)
  }
  return value as NotebookCell
}

export function parseNotebook(source: string): NotebookDocument {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error('Notebook is not valid JSON', { cause: error })
  }
  if (!isRecord(value) || !Array.isArray(value.cells)) {
    throw new Error('Notebook must contain a cells array')
  }
  return {
    ...value,
    cells: value.cells.map(parseCell),
  } as NotebookDocument
}

function cellId(cell: NotebookCell, index: number): string {
  return typeof cell.id === 'string' && cell.id.length > 0
    ? cell.id
    : `cell-${index}`
}

function cellSource(cell: NotebookCell): string {
  return Array.isArray(cell.source) ? cell.source.join('') : cell.source
}

function outputText(output: unknown): string {
  if (!isRecord(output)) return ''
  for (const value of [
    output.text,
    isRecord(output.data) ? output.data['text/plain'] : undefined,
    output.traceback,
  ]) {
    if (typeof value === 'string') return value
    if (
      Array.isArray(value) &&
      value.every((line) => typeof line === 'string')
    ) {
      return value.join(value === output.traceback ? '\n' : '')
    }
  }
  return ''
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
}

export function formatNotebookForRead(source: string): string {
  const notebook = parseNotebook(source)
  return notebook.cells
    .map((cell, index) => {
      const id = escapeAttribute(cellId(cell, index))
      const type =
        cell.cell_type === 'code'
          ? ''
          : `<cell_type>${cell.cell_type}</cell_type>`
      const body = `<cell id="${id}">${type}${cellSource(cell)}</cell id="${id}">`
      const outputs = Array.isArray(cell.outputs)
        ? cell.outputs.map(outputText).filter(Boolean).join('\n')
        : ''
      return outputs ? `${body}\n\n${outputs}` : body
    })
    .join('\n')
}

function newCellId(cells: readonly NotebookCell[]): string {
  const ids = new Set(cells.map((cell, index) => cellId(cell, index)))
  for (;;) {
    const id = randomBytes(4).toString('hex')
    if (!ids.has(id)) return id
  }
}

function findCellIndex(
  cells: readonly NotebookCell[],
  requestedId: string,
): number {
  const matches = cells.flatMap((cell, index) =>
    cellId(cell, index) === requestedId ? [index] : [],
  )
  if (matches.length === 0) throw new Error(`Cell ${requestedId} was not found`)
  if (matches.length > 1) throw new Error(`Cell ID ${requestedId} is ambiguous`)
  return matches[0] ?? -1
}

function insertedCell(
  type: 'code' | 'markdown',
  id: string,
  source: string,
): NotebookCell {
  return type === 'code'
    ? {
        cell_type: 'code',
        execution_count: null,
        id,
        metadata: {},
        outputs: [],
        source,
      }
    : { cell_type: 'markdown', id, source, metadata: {} }
}

function replaceCellType(
  cell: NotebookCell,
  type: 'code' | 'markdown',
): NotebookCell {
  if (cell.cell_type === type) return cell
  if (type === 'code') {
    return { ...cell, cell_type: type, execution_count: null, outputs: [] }
  }
  const markdown: NotebookCell = { ...cell, cell_type: type }
  delete markdown.execution_count
  delete markdown.outputs
  return markdown
}

export function editNotebook(
  source: string,
  input: NotebookEditInput,
): NotebookEditResult {
  const notebook = parseNotebook(source)
  const cells = [...notebook.cells]
  if (input.editMode === 'insert') {
    if (!input.cellType) throw new Error('cell_type is required for insert')
    const id = newCellId(cells)
    const index = input.cellId ? findCellIndex(cells, input.cellId) + 1 : 0
    cells.splice(index, 0, insertedCell(input.cellType, id, input.newSource))
    return {
      content: `Inserted cell ${id} with ${input.newSource}`,
      source: JSON.stringify({ ...notebook, cells }, null, 1),
    }
  }

  if (!input.cellId) {
    throw new Error(`cell_id is required for ${input.editMode}`)
  }
  const index = findCellIndex(cells, input.cellId)
  if (input.editMode === 'delete') {
    cells.splice(index, 1)
    return {
      content: `Deleted cell ${input.cellId}`,
      source: JSON.stringify({ ...notebook, cells }, null, 1),
    }
  }

  const current = cells[index]
  if (!current) throw new Error(`Cell ${input.cellId} was not found`)
  const cell = input.cellType
    ? replaceCellType(current, input.cellType)
    : current
  cells[index] = { ...cell, source: input.newSource }
  return {
    content: `Updated cell ${input.cellId} with ${input.newSource}`,
    source: JSON.stringify({ ...notebook, cells }, null, 1),
  }
}
