import type {
  PermissionDecision,
  PermissionResolver,
  PermissionResolutionContext,
} from './runtime.js'

/** Intersects a child resolver with its immutable parent permission ceiling. */
export function composePermissionResolvers(
  parent: PermissionResolver,
  child: PermissionResolver,
): PermissionResolver {
  return {
    async resolve(
      call,
      context?: PermissionResolutionContext,
    ): Promise<PermissionDecision> {
      const [parentDecision, childDecision] = await Promise.all([
        parent.resolve(call, context),
        child.resolve(call, context),
      ])
      if (parentDecision.behavior === 'deny') return parentDecision
      if (childDecision.behavior === 'deny') return childDecision
      if (parentDecision.behavior === 'ask') return parentDecision
      if (childDecision.behavior === 'ask') return childDecision
      return parentDecision
    },
  }
}
