import { describe, expect, it } from 'vitest'

import {
  formatDiagnostics,
  parsePublishDiagnostics,
} from './lsp-diagnostics.js'

describe('LSP diagnostics', () => {
  it('strictly parses and formats a publication', () => {
    const publication = parsePublishDiagnostics({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: 'file:///workspace/main.ts',
        version: 2,
        diagnostics: [
          {
            range: {
              start: { line: 1, character: 2 },
              end: { line: 1, character: 3 },
            },
            severity: 2,
            code: 'W1',
            message: 'bad <value> SECRET',
          },
        ],
      },
    })
    expect(publication).toMatchObject({
      filePath: '/workspace/main.ts',
      version: 2,
      diagnostics: [
        {
          line: 2,
          column: 3,
          severity: 'warning',
          code: 'W1',
        },
      ],
    })
    expect(
      formatDiagnostics(publication?.diagnostics ?? [], '/workspace', [
        'SECRET',
      ]),
    ).toBe(
      '<diagnostics>\nmain.ts:2:3 warning W1 bad &lt;value&gt; [REDACTED]\n</diagnostics>',
    )
  })

  it('rejects invalid core fields and handles empty publications', () => {
    const base = {
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: 'file:///workspace/main.ts',
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            message: 'message',
          },
        ],
      },
    }
    const invalid = [
      { ...base, jsonrpc: '1.0' },
      { ...base, id: 1 },
      { ...base, method: 'other' },
      {
        ...base,
        params: { ...base.params, uri: 'file:///workspace/main.ts?old' },
      },
      { ...base, params: { ...base.params, version: -1 } },
      {
        ...base,
        params: {
          ...base.params,
          diagnostics: [{ ...base.params.diagnostics[0], message: 1 }],
        },
      },
      {
        ...base,
        params: {
          ...base.params,
          diagnostics: [
            {
              ...base.params.diagnostics[0],
              range: {
                start: { line: 2, character: 0 },
                end: { line: 1, character: 0 },
              },
            },
          ],
        },
      },
      {
        ...base,
        params: {
          ...base.params,
          diagnostics: [{ ...base.params.diagnostics[0], severity: 0 }],
        },
      },
      {
        ...base,
        params: {
          ...base.params,
          diagnostics: [{ ...base.params.diagnostics[0], code: {} }],
        },
      },
    ]
    for (const value of invalid)
      expect(() => parsePublishDiagnostics(value)).not.toThrow()
    for (const value of invalid)
      expect(parsePublishDiagnostics(value)).toBeNull()
    expect(
      parsePublishDiagnostics({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: { uri: 'file:///workspace/main.ts', diagnostics: [] },
      })?.diagnostics,
    ).toEqual([])
    expect(parsePublishDiagnostics(base)?.diagnostics[0]).toMatchObject({
      severity: 'error',
      code: '',
    })
  })

  it('sorts by relative location and sanitizes records', () => {
    const records = [
      {
        canonicalPath: '/workspace/z.ts',
        line: 1,
        column: 1,
        severity: 'hint' as const,
        code: 'Z',
        message: 'z',
      },
      {
        canonicalPath: '/workspace/a.ts',
        line: 2,
        column: 1,
        severity: 'warning' as const,
        code: 'B',
        message: 'two\n\u0085\u2028\u2029lines',
      },
      {
        canonicalPath: '/workspace/a.ts',
        line: 1,
        column: 1,
        severity: 'error' as const,
        code: '<A>',
        message: 'x\r\ny <tag>',
      },
    ]
    expect(formatDiagnostics(records, '/workspace', ['lines'])).toBe(
      '<diagnostics>\na.ts:1:1 error &lt;A&gt; x y &lt;tag&gt;\na.ts:2:1 warning B two [REDACTED]\nz.ts:1:1 hint Z z\n</diagnostics>',
    )
  })

  it('caps records and UTF-8 output', () => {
    const records = Array.from({ length: 10 }, (_, index) => ({
      canonicalPath: '/workspace/main.ts',
      line: index + 1,
      column: 1,
      severity: 'error' as const,
      code: 'E',
      message: 'x',
    }))
    const formatted = formatDiagnostics(records, '/workspace')
    expect(formatted).toContain('… diagnostics truncated')
    expect((formatted?.match(/\n/g) ?? []).length).toBe(10)
    expect(Buffer.byteLength(formatted ?? '', 'utf8')).toBeLessThanOrEqual(4096)
  })

  it('truncates oversized UTF-8 records to a marker-only block', () => {
    const formatted = formatDiagnostics(
      [
        {
          canonicalPath: '/workspace/main.ts',
          line: 1,
          column: 1,
          severity: 'error',
          code: 'E',
          message: '界'.repeat(5000),
        },
      ],
      '/workspace',
    )
    expect(formatted).toBe(
      '<diagnostics>\n… diagnostics truncated\n</diagnostics>',
    )
    expect(Buffer.byteLength(formatted ?? '', 'utf8')).toBeLessThanOrEqual(4096)
  })

  it('keeps preceding records when a later UTF-8 record exceeds the byte cap', () => {
    const discardedTail = 'discarded-tail-marker'
    const formatted = formatDiagnostics(
      [
        {
          canonicalPath: '/workspace/a.ts',
          line: 1,
          column: 1,
          severity: 'error',
          code: 'E1',
          message: 'retained',
        },
        {
          canonicalPath: '/workspace/b.ts',
          line: 1,
          column: 1,
          severity: 'error',
          code: 'E2',
          message: `${'界'.repeat(5000)} ${discardedTail}`,
        },
      ],
      '/workspace',
    )
    expect(formatted).toContain('a.ts:1:1 error E1 retained')
    expect(formatted).toContain('… diagnostics truncated')
    expect(formatted).not.toContain(discardedTail)
    expect(Buffer.byteLength(formatted ?? '', 'utf8')).toBeLessThanOrEqual(4096)
  })
})
