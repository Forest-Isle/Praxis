import { relative } from 'node:path'

interface Position {
  line: number
  character: number
}

interface Range {
  start: Position
  end: Position
}

interface Location {
  uri: string
  range: Range
}

interface LocationLink {
  targetUri: string
  targetRange: Range
  targetSelectionRange?: Range
}

interface DocumentSymbol {
  name: string
  detail?: string
  kind: number
  range: Range
  children?: DocumentSymbol[]
}

interface SymbolInformation {
  name: string
  kind: number
  location: Location
  containerName?: string
}

interface CallHierarchyItem {
  name: string
  detail?: string
  kind: number
  uri: string
  range: Range
}

interface IncomingCall {
  from: CallHierarchyItem
  fromRanges: Range[]
}

interface OutgoingCall {
  to: CallHierarchyItem
  fromRanges: Range[]
}

const NO_DEFINITION =
  'No definition found. This may occur if the cursor is not on a symbol, or if the definition is in an external library not indexed by the LSP server.'
const NO_REFERENCES =
  'No references found. This may occur if the symbol has no usages, or if the LSP server has not fully indexed the workspace.'
const NO_HOVER =
  'No hover information available. This may occur if the cursor is not on a symbol, or if the LSP server has not fully indexed the file.'
const NO_DOCUMENT_SYMBOLS =
  'No symbols found in document. This may occur if the file is empty, not supported by the LSP server, or if the server has not fully indexed the file.'
const NO_WORKSPACE_SYMBOLS =
  'No symbols found in workspace. This may occur if the workspace is empty, or if the LSP server has not finished indexing the project.'

const SYMBOL_KINDS = [
  '',
  'File',
  'Module',
  'Namespace',
  'Package',
  'Class',
  'Method',
  'Property',
  'Field',
  'Constructor',
  'Enum',
  'Interface',
  'Function',
  'Variable',
  'Constant',
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'Key',
  'Null',
  'EnumMember',
  'Struct',
  'Event',
  'Operator',
  'TypeParameter',
] as const

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`
}

function symbolKind(kind: number): string {
  return SYMBOL_KINDS[kind] ?? 'Unknown'
}

function formatUri(uri: string | undefined, cwd?: string): string {
  if (!uri) return '<unknown location>'
  let filePath = uri.replace(/^file:\/\//u, '')
  if (/^\/[A-Za-z]:/u.test(filePath)) filePath = filePath.slice(1)
  try {
    filePath = decodeURIComponent(filePath)
  } catch {
    // Preserve malformed-but-readable server paths, matching Claude's fallback.
  }
  if (cwd) {
    const relativePath = relative(cwd, filePath).replaceAll('\\', '/')
    if (
      relativePath.length < filePath.length &&
      !relativePath.startsWith('../../')
    ) {
      return relativePath
    }
  }
  return filePath.replaceAll('\\', '/')
}

function formatLocation(location: Location, cwd?: string): string {
  return `${formatUri(location.uri, cwd)}:${location.range.start.line + 1}:${location.range.start.character + 1}`
}

function isLocation(value: unknown): value is Location {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as Location).uri === 'string',
  )
}

function isLocationLink(value: unknown): value is LocationLink {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as LocationLink).targetUri === 'string',
  )
}

function toLocation(value: unknown): Location | undefined {
  if (isLocation(value)) return value
  if (!isLocationLink(value)) return undefined
  return {
    uri: value.targetUri,
    range: value.targetSelectionRange ?? value.targetRange,
  }
}

function formatDefinitions(result: unknown, cwd?: string): string {
  if (!result) return NO_DEFINITION
  const values = Array.isArray(result) ? result : [result]
  const locations = values
    .map((value) => toLocation(value))
    .filter((value): value is Location => value !== undefined)
  if (locations.length === 0) return NO_DEFINITION
  const onlyLocation = locations.at(0)
  if (locations.length === 1 && onlyLocation)
    return `Defined in ${formatLocation(onlyLocation, cwd)}`
  return `Found ${locations.length} definitions:\n${locations
    .map((location) => `  ${formatLocation(location, cwd)}`)
    .join('\n')}`
}

function groupByFile<T>(
  values: T[],
  uri: (value: T) => string,
  cwd?: string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const value of values) {
    const filePath = formatUri(uri(value), cwd)
    const existing = grouped.get(filePath)
    if (existing) existing.push(value)
    else grouped.set(filePath, [value])
  }
  return grouped
}

function formatReferences(result: unknown, cwd?: string): string {
  const locations = Array.isArray(result) ? result.filter(isLocation) : []
  if (locations.length === 0) return NO_REFERENCES
  const onlyLocation = locations.at(0)
  if (locations.length === 1 && onlyLocation)
    return `Found 1 reference:\n  ${formatLocation(onlyLocation, cwd)}`
  const grouped = groupByFile(locations, (location) => location.uri, cwd)
  const lines = [
    `Found ${locations.length} references across ${grouped.size} files:`,
  ]
  for (const [filePath, fileLocations] of grouped) {
    lines.push(`\n${filePath}:`)
    for (const location of fileLocations) {
      lines.push(
        `  Line ${location.range.start.line + 1}:${location.range.start.character + 1}`,
      )
    }
  }
  return lines.join('\n')
}

function markupText(contents: unknown): string {
  if (Array.isArray(contents)) {
    return contents
      .map((item) =>
        typeof item === 'string'
          ? item
          : String((item as { value?: unknown })?.value ?? ''),
      )
      .join('\n\n')
  }
  if (typeof contents === 'string') return contents
  if (contents && typeof contents === 'object') {
    return String((contents as { value?: unknown }).value ?? '')
  }
  return ''
}

function formatHover(result: unknown): string {
  if (!result || typeof result !== 'object') return NO_HOVER
  const hover = result as { contents?: unknown; range?: Range }
  const content = markupText(hover.contents)
  if (hover.range) {
    return `Hover info at ${hover.range.start.line + 1}:${hover.range.start.character + 1}:\n\n${content}`
  }
  return content
}

function formatDocumentNode(symbol: DocumentSymbol, indent = 0): string[] {
  let line = `${'  '.repeat(indent)}${symbol.name} (${symbolKind(symbol.kind)})`
  if (symbol.detail) line += ` ${symbol.detail}`
  line += ` - Line ${symbol.range.start.line + 1}`
  const lines = [line]
  for (const child of symbol.children ?? []) {
    lines.push(...formatDocumentNode(child, indent + 1))
  }
  return lines
}

function isSymbolInformation(value: unknown): value is SymbolInformation {
  return Boolean(
    value && typeof value === 'object' && (value as SymbolInformation).location,
  )
}

function formatWorkspaceSymbols(result: unknown, cwd?: string): string {
  const symbols = Array.isArray(result)
    ? result.filter(isSymbolInformation).filter((symbol) => symbol.location.uri)
    : []
  if (symbols.length === 0) return NO_WORKSPACE_SYMBOLS
  const lines = [
    `Found ${symbols.length} ${plural(symbols.length, 'symbol')} in workspace:`,
  ]
  const grouped = groupByFile(symbols, (symbol) => symbol.location.uri, cwd)
  for (const [filePath, fileSymbols] of grouped) {
    lines.push(`\n${filePath}:`)
    for (const symbol of fileSymbols) {
      let line = `  ${symbol.name} (${symbolKind(symbol.kind)}) - Line ${symbol.location.range.start.line + 1}`
      if (symbol.containerName) line += ` in ${symbol.containerName}`
      lines.push(line)
    }
  }
  return lines.join('\n')
}

function formatDocumentSymbols(result: unknown, cwd?: string): string {
  if (!Array.isArray(result) || result.length === 0) return NO_DOCUMENT_SYMBOLS
  if (isSymbolInformation(result[0])) return formatWorkspaceSymbols(result, cwd)
  const lines = ['Document symbols:']
  for (const symbol of result as DocumentSymbol[]) {
    lines.push(...formatDocumentNode(symbol))
  }
  return lines.join('\n')
}

function formatCallItem(item: CallHierarchyItem, cwd?: string): string {
  let result = `${item.name} (${symbolKind(item.kind)}) - ${formatUri(item.uri, cwd)}:${item.range.start.line + 1}`
  if (item.detail) result += ` [${item.detail}]`
  return result
}

function formatPreparedCalls(result: unknown, cwd?: string): string {
  if (!Array.isArray(result) || result.length === 0)
    return 'No call hierarchy item found at this position'
  const items = result as CallHierarchyItem[]
  const onlyItem = items.at(0)
  if (items.length === 1 && onlyItem)
    return `Call hierarchy item: ${formatCallItem(onlyItem, cwd)}`
  return [
    `Found ${items.length} call hierarchy items:`,
    ...items.map((item) => `  ${formatCallItem(item, cwd)}`),
  ].join('\n')
}

function formatIncomingCalls(result: unknown, cwd?: string): string {
  if (!Array.isArray(result) || result.length === 0)
    return 'No incoming calls found (nothing calls this function)'
  const calls = (result as IncomingCall[]).filter((call) => call.from)
  const lines = [
    `Found ${result.length} incoming ${plural(result.length, 'call')}:`,
  ]
  const grouped = groupByFile(calls, (call) => call.from.uri, cwd)
  for (const [filePath, fileCalls] of grouped) {
    lines.push(`\n${filePath}:`)
    for (const call of fileCalls) {
      let line = `  ${call.from.name} (${symbolKind(call.from.kind)}) - Line ${call.from.range.start.line + 1}`
      if (call.fromRanges?.length) {
        const sites = call.fromRanges
          .map(
            (range) => `${range.start.line + 1}:${range.start.character + 1}`,
          )
          .join(', ')
        line += ` [calls at: ${sites}]`
      }
      lines.push(line)
    }
  }
  return lines.join('\n')
}

function formatOutgoingCalls(result: unknown, cwd?: string): string {
  if (!Array.isArray(result) || result.length === 0)
    return 'No outgoing calls found (this function calls nothing)'
  const calls = (result as OutgoingCall[]).filter((call) => call.to)
  const lines = [
    `Found ${result.length} outgoing ${plural(result.length, 'call')}:`,
  ]
  const grouped = groupByFile(calls, (call) => call.to.uri, cwd)
  for (const [filePath, fileCalls] of grouped) {
    lines.push(`\n${filePath}:`)
    for (const call of fileCalls) {
      let line = `  ${call.to.name} (${symbolKind(call.to.kind)}) - Line ${call.to.range.start.line + 1}`
      if (call.fromRanges?.length) {
        const sites = call.fromRanges
          .map(
            (range) => `${range.start.line + 1}:${range.start.character + 1}`,
          )
          .join(', ')
        line += ` [called from: ${sites}]`
      }
      lines.push(line)
    }
  }
  return lines.join('\n')
}

export function formatClaudeLspResult(
  operation: string,
  result: unknown,
  cwd: string,
): string {
  switch (operation) {
    case 'goToDefinition':
    case 'goToImplementation':
      return formatDefinitions(result, cwd)
    case 'findReferences':
      return formatReferences(result, cwd)
    case 'hover':
      return formatHover(result)
    case 'documentSymbol':
      return formatDocumentSymbols(result, cwd)
    case 'workspaceSymbol':
      return formatWorkspaceSymbols(result, cwd)
    case 'prepareCallHierarchy':
      return formatPreparedCalls(result, cwd)
    case 'incomingCalls':
      return formatIncomingCalls(result, cwd)
    case 'outgoingCalls':
      return formatOutgoingCalls(result, cwd)
    default:
      throw new Error(`Unsupported LSP operation ${operation}`)
  }
}
