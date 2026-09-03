import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { redactSensitiveText } from '../platform/sensitive-data.js'

export type DiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint'

export interface LspDiagnosticRecord {
  canonicalPath: string
  line: number
  column: number
  severity: DiagnosticSeverity
  code: string
  message: string
}

export interface LspDiagnosticsPublication {
  uri: string
  filePath: string
  version?: number
  diagnostics: readonly LspDiagnosticRecord[]
}

const severityNames: Record<number, DiagnosticSeverity> = {
  1: 'error',
  2: 'warning',
  3: 'information',
  4: 'hint',
}

const severityRank: Record<DiagnosticSeverity, number> = {
  error: 0,
  warning: 1,
  information: 2,
  hint: 3,
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function recordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function localFilePath(uri: unknown): string | null {
  if (typeof uri !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return null
  }
  if (parsed.protocol !== 'file:' || parsed.search || parsed.hash) return null
  try {
    return fileURLToPath(parsed)
  } catch {
    return null
  }
}

/** Parse one strict, id-less LSP publishDiagnostics notification. */
export function parsePublishDiagnostics(
  value: unknown,
): LspDiagnosticsPublication | null {
  try {
    if (!recordObject(value) || value.jsonrpc !== '2.0') return null
    if (
      value.id !== undefined ||
      value.method !== 'textDocument/publishDiagnostics'
    )
      return null
    if (!recordObject(value.params)) return null
    const params = value.params
    const uri = params.uri
    const rawPath = localFilePath(uri)
    if (!rawPath || typeof uri !== 'string') return null
    const filePath = rawPath
    const version = params.version
    if (version !== undefined && !safeInteger(version)) return null
    if (!Array.isArray(params.diagnostics)) return null
    const diagnostics: LspDiagnosticRecord[] = []
    for (const value of params.diagnostics) {
      if (!recordObject(value) || typeof value.message !== 'string') return null
      if (!recordObject(value.range)) return null
      const range = value.range
      if (!recordObject(range.start) || !recordObject(range.end)) return null
      const start = range.start
      const end = range.end
      if (
        !safeInteger(start.line) ||
        !safeInteger(start.character) ||
        !safeInteger(end.line) ||
        !safeInteger(end.character) ||
        end.line < start.line ||
        (end.line === start.line && end.character < start.character)
      )
        return null
      const severity = value.severity
      if (
        severity !== undefined &&
        (!safeInteger(severity) || severity < 1 || severity > 4)
      )
        return null
      const code = value.code
      if (
        code !== undefined &&
        !(
          typeof code === 'string' ||
          (typeof code === 'number' && Number.isFinite(code))
        )
      )
        return null
      diagnostics.push({
        canonicalPath: filePath,
        line: start.line + 1,
        column: start.character + 1,
        severity: severityNames[severity ?? 1] ?? 'error',
        code: code === undefined ? '' : String(code),
        message: value.message,
      })
    }
    return {
      uri,
      filePath,
      ...(version === undefined ? {} : { version }),
      diagnostics,
    }
  } catch {
    return null
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sanitize(value: string, sensitiveValues: readonly string[]): string {
  const redacted = redactSensitiveText(value, sensitiveValues)
  let controlsCollapsed = ''
  let inControls = false
  for (const character of redacted) {
    const code = character.codePointAt(0) ?? 0
    const control =
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
    if (control) {
      if (!inControls) controlsCollapsed += ' '
      inControls = true
    } else {
      controlsCollapsed += character
      inControls = false
    }
  }
  return controlsCollapsed.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function relativePath(path: string, cwd: string): string {
  return relative(cwd, path).replaceAll('\\', '/').replace(/^\.\//u, '')
}

function compareRecords(
  a: LspDiagnosticRecord,
  b: LspDiagnosticRecord,
  cwd: string,
): number {
  const aPath = relativePath(a.canonicalPath, cwd)
  const bPath = relativePath(b.canonicalPath, cwd)
  return (
    compareText(aPath, bPath) ||
    a.line - b.line ||
    a.column - b.column ||
    severityRank[a.severity] - severityRank[b.severity] ||
    compareText(a.code, b.code) ||
    compareText(a.message, b.message)
  )
}

/** Format diagnostics as one bounded provider-visible block. */
export function formatDiagnostics(
  diagnostics: readonly LspDiagnosticRecord[],
  cwd: string,
  sensitiveValues: readonly string[] = [],
): string | null {
  if (diagnostics.length === 0) return null
  const sorted = [...diagnostics].sort((a, b) => compareRecords(a, b, cwd))
  const marker = '… diagnostics truncated'
  const lines: string[] = []
  let truncated = sorted.length > 8
  for (const diagnostic of sorted.slice(0, 8)) {
    const code = sanitize(diagnostic.code, sensitiveValues)
    const message = sanitize(diagnostic.message, sensitiveValues)
    const line = `${sanitize(relativePath(diagnostic.canonicalPath, cwd), sensitiveValues)}:${diagnostic.line}:${diagnostic.column} ${sanitize(diagnostic.severity, sensitiveValues)}${code ? ` ${code}` : ''} ${message}`
    const candidate = `<diagnostics>\n${[...lines, line].join('\n')}\n</diagnostics>`
    if (Buffer.byteLength(candidate, 'utf8') > 4096) {
      truncated = true
      break
    }
    lines.push(line)
  }
  if (truncated) {
    while (
      Buffer.byteLength(
        `<diagnostics>\n${[...lines, marker].join('\n')}\n</diagnostics>`,
        'utf8',
      ) > 4096
    )
      lines.pop()
    lines.push(marker)
  }
  return `<diagnostics>\n${lines.join('\n')}\n</diagnostics>`
}
