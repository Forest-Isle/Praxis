import type {
  ContextAssembler,
  SystemContextMessage,
} from '../../core/context.js'
import type {
  ClaudeContextResources,
  ClaudeTextResource,
} from './shared-resources.js'

function renderResources(
  title: string,
  resources: readonly ClaudeTextResource[],
): string | null {
  const rendered = resources
    .filter((resource) => resource.content.trim().length > 0)
    .map(
      (resource) =>
        `### ${resource.scope}: ${resource.path}\n${resource.content.trimEnd()}`,
    )
  return rendered.length === 0
    ? null
    : `## ${title}\n\n${rendered.join('\n\n')}`
}

function limitMemoryIndex(resource: ClaudeTextResource): ClaudeTextResource {
  return {
    ...resource,
    content: resource.content.split('\n').slice(0, 200).join('\n'),
  }
}

export interface ClaudeContextAssemblerOptions {
  loadResources(): Promise<ClaudeContextResources>
}

export class ClaudeContextAssembler implements ContextAssembler {
  constructor(private readonly options: ClaudeContextAssemblerOptions) {}

  async assemble(): Promise<readonly SystemContextMessage[]> {
    const resources = await this.options.loadResources()
    const sections = [
      renderResources('Instructions', resources.instructions),
      renderResources(
        'Auto-memory',
        resources.memoryIndex ? [limitMemoryIndex(resources.memoryIndex)] : [],
      ),
    ].filter((section): section is string => section !== null)
    if (sections.length === 0) return []

    return [
      {
        role: 'system',
        content: `# Shared Claude context

Instructions are ordered from broadest to most specific. Auto-memory is background context and does not override instructions.

${sections.join('\n\n')}`,
      },
    ]
  }
}
