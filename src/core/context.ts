import type { ModelMessage } from './runtime.js'

export type SystemContextMessage = Extract<ModelMessage, { role: 'system' }>

export interface AssembledContext {
  systemMessages: readonly SystemContextMessage[]
  firstUserMessageContext?: string
}

export interface ContextAssemblyOptions {
  cwd?: string
}

export interface ContextAssembler {
  assemble(options?: ContextAssemblyOptions): Promise<AssembledContext>
}

export function injectFirstUserMessageContext(
  messages: readonly ModelMessage[],
  context: string | undefined,
): ModelMessage[] {
  if (context === undefined) return [...messages]
  let injected = false
  const result = messages.map((message) => {
    if (injected || message.role !== 'user') return message
    injected = true
    return { ...message, content: `${context}\n\n${message.content}` }
  })
  return injected ? result : [...result, { role: 'user', content: context }]
}
