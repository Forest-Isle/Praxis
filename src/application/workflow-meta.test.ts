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
