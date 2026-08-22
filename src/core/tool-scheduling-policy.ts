import type {
  ModelToolCall,
  ToolRegistry,
  ToolSchedulingPolicy,
} from './runtime.js'

export const exclusiveToolSchedulingPolicy: ToolSchedulingPolicy = {
  concurrency: 'exclusive',
}

export function resolveToolSchedulingPolicy(
  tools: ToolRegistry | undefined,
  call: ModelToolCall,
): ToolSchedulingPolicy {
  try {
    const policy = tools?.schedulingPolicy?.(structuredClone(call))
    if (
      !policy ||
      (policy.concurrency !== 'concurrent' &&
        policy.concurrency !== 'exclusive') ||
      (policy.cancelOnInterrupt !== undefined &&
        typeof policy.cancelOnInterrupt !== 'boolean') ||
      (policy.abortGroupOnError !== undefined &&
        typeof policy.abortGroupOnError !== 'boolean') ||
      (policy.startAfterAssistant !== undefined &&
        typeof policy.startAfterAssistant !== 'boolean')
    ) {
      return exclusiveToolSchedulingPolicy
    }
    return policy
  } catch {
    return exclusiveToolSchedulingPolicy
  }
}
