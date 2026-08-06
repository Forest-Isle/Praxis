import { describe, expect, it } from 'vitest'

import { workflowTokenTarget } from './session-service.js'

describe('workflowTokenTarget', () => {
  it('reads k/m token directives and leaves ordinary prompts unbounded', () => {
    expect(workflowTokenTarget('run workflow +500k')).toBe(500_000)
    expect(workflowTokenTarget('+1.5m exhaustive audit')).toBe(1_500_000)
    expect(workflowTokenTarget('run workflow')).toBeNull()
  })
})
