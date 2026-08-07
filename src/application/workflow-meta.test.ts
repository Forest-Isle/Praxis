import { describe, expect, it } from 'vitest'

import { parseWorkflowScript } from './workflow-meta.js'

describe('parseWorkflowScript', () => {
  it('extracts a pure first-statement meta literal and leaves the body', () => {
    const parsed = parseWorkflowScript(`export const meta = {
  name: 'review',
  description: 'Review code',
  phases: [{ title: 'Scan', detail: 'Find issues' }],
}
phase('Scan')
return { ok: true }`)
    expect(parsed.meta).toEqual({
      name: 'review',
      description: 'Review code',
      phases: [{ title: 'Scan', detail: 'Find issues' }],
    })
    expect(parsed.body).toContain("phase('Scan')")
    expect(parsed.orderedReplaySafe).toBe(true)
  })

  it('marks direct and aliased nested/budget access unsafe for ordered replay', () => {
    const parseBody = (body: string) =>
      parseWorkflowScript(`export const meta = {
  name: 'replay-check',
  description: 'Check replay safety',
}
${body}`).orderedReplaySafe

    expect(parseBody("return workflow('nested')")).toBe(false)
    expect(parseBody('const nested = workflow\nreturn nested()')).toBe(false)
    expect(parseBody('const { remaining } = budget\nreturn remaining()')).toBe(
      false,
    )
    expect(
      parseBody("return { note: 'workflow and budget are ordinary words' }"),
    ).toBe(true)
  })

  it('rejects missing, impure, and incomplete metadata before execution', () => {
    expect(() => parseWorkflowScript('return 1')).toThrow(
      'must be the FIRST statement',
    )
    expect(() =>
      parseWorkflowScript(
        `export const meta = makeMeta()
return 1`,
      ),
    ).toThrow(
      'meta must be a pure literal: non-literal node type in meta: CallExpression',
    )
    expect(() =>
      parseWorkflowScript(`export const meta = { name: 'x' }
return 1`),
    ).toThrow('meta.description must be a non-empty string')
  })
})
