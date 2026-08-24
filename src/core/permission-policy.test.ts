import { describe, expect, it } from 'vitest'
import { composePermissionResolvers } from './permission-policy.js'
import type { PermissionDecision } from './runtime.js'

const call = { name: 'Read', input: {} } as never
const resolver = (decision: PermissionDecision) => ({ resolve: () => decision })

describe('permission policy composition', () => {
  it.each([
    ['deny', 'deny', 'deny'],
    ['deny', 'ask', 'deny'],
    ['deny', 'allow', 'deny'],
    ['allow', 'deny', 'deny'],
    ['ask', 'deny', 'deny'],
    ['ask', 'allow', 'ask'],
    ['allow', 'ask', 'ask'],
    ['ask', 'ask', 'ask'],
    ['allow', 'allow', 'allow'],
  ])('%s + %s => %s', async (parent, child, expected) => {
    const parentDecision = (
      parent === 'deny'
        ? { behavior: parent, reason: 'parent' }
        : { behavior: parent, metadata: { source: parent } }
    ) as PermissionDecision
    const childDecision = (
      child === 'deny'
        ? { behavior: child, reason: 'child' }
        : { behavior: child, metadata: { source: child } }
    ) as PermissionDecision
    const result = await composePermissionResolvers(
      resolver(parentDecision),
      resolver(childDecision),
    ).resolve(call)
    expect(result.behavior).toBe(expected)
    expect(result).toBe(
      expected === 'ask'
        ? parent === 'ask'
          ? parentDecision
          : childDecision
        : parent === 'deny'
          ? parentDecision
          : child === 'deny'
            ? childDecision
            : parentDecision,
    )
  })
})
