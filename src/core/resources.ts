export type ResourceScope = 'local' | 'project' | 'user'

export interface TextResource {
  path: string
  scope: ResourceScope
  content: string
  importedFrom?: string
  importRoot?: string
}

export interface JsonResource {
  path: string
  scope: ResourceScope
  value: unknown
  plugin?: true
  pluginName?: string
  pluginSource?: string
  environment?: Readonly<Record<string, string>>
  sensitiveValues?: readonly string[]
}

export interface ContextResources {
  instructions: TextResource[]
  conditionalRules: ConditionalRule[]
  memoryIndex: TextResource | null
}

export interface ConditionalRule extends TextResource {
  baseDirectory: string
  content: string
  globs: string[]
  rawContent: string
}

export interface SharedResources {
  instructions: TextResource[]
  memory: TextResource[]
  skills: TextResource[]
  commands: TextResource[]
  agents: TextResource[]
  settings: JsonResource[]
  mcp: JsonResource[]
}
