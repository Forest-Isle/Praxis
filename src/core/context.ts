export interface SystemContextMessage {
  role: 'system'
  content: string
}

export interface ContextAssembler {
  assemble(): Promise<readonly SystemContextMessage[]>
}
