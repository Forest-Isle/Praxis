import { isAbsolute, matchesGlob, relative, resolve, sep } from 'node:path'

import type {
  AssembledContext,
  ContextAssembler,
  SystemContextMessage,
} from '../../core/context.js'
import {
  renderClaudeDynamicSystemContext,
  renderClaudeDynamicUserContext,
  type ClaudeDynamicContextSections,
} from './dynamic-context.js'
import type {
  ClaudeContextResources,
  ClaudeConditionalRule,
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
  loadResources(cwd?: string): Promise<ClaudeContextResources>
  loadDynamicContext?(cwd?: string): Promise<ClaudeDynamicContextSections>
  excludeDynamicSystemPromptSections?: boolean
  systemPrompt?: string
  appendSystemPrompt?: string
}

export type ClaudeConditionalRuleResolverOptions = ClaudeContextAssemblerOptions

export class ClaudeConditionalRuleResolver {
  constructor(private readonly options: ClaudeConditionalRuleResolverOptions) {}

  async resolve(
    filePath: string,
    attachedRulePaths: readonly string[] = [],
  ): Promise<readonly ClaudeConditionalRule[]> {
    const absoluteFilePath = resolve(filePath)
    const attached = new Set(attachedRulePaths)
    const resources = await this.options.loadResources()
    return resources.conditionalRules.filter((rule) => {
      if (attached.has(rule.path)) return false
      const pathFromBase = relative(rule.baseDirectory, absoluteFilePath)
      if (
        pathFromBase === '' ||
        pathFromBase === '..' ||
        pathFromBase.startsWith(`..${sep}`) ||
        isAbsolute(pathFromBase)
      ) {
        return false
      }
      const rulePath = pathFromBase.split(sep).join('/')
      return rule.globs.some((glob) =>
        matchesGlob(rulePath, glob.replace(/^\.\//, '')),
      )
    })
  }
}

export class ClaudeContextAssembler implements ContextAssembler {
  constructor(private readonly options: ClaudeContextAssemblerOptions) {}

  async assemble(options: { cwd?: string } = {}): Promise<AssembledContext> {
    const resources = await this.options.loadResources(options.cwd)
    const sections = [
      renderResources('Instructions', resources.instructions),
      renderResources(
        'Auto-memory',
        resources.memoryIndex ? [limitMemoryIndex(resources.memoryIndex)] : [],
      ),
    ].filter((section): section is string => section !== null)
    const messages: SystemContextMessage[] = []
    if (this.options.systemPrompt !== undefined) {
      messages.push({ role: 'system', content: this.options.systemPrompt })
    }
    if (sections.length > 0) {
      messages.push({
        role: 'system',
        content: `# Shared Claude context

Instructions are ordered from broadest to most specific. Auto-memory is background context and does not override instructions.

${sections.join('\n\n')}`,
      })
    }
    let firstUserMessageContext: string | undefined
    if (
      this.options.systemPrompt === undefined &&
      this.options.loadDynamicContext !== undefined
    ) {
      const dynamic = await this.options.loadDynamicContext(options.cwd)
      if (this.options.excludeDynamicSystemPromptSections) {
        if (dynamic.memory) {
          messages.push({ role: 'system', content: dynamic.memory })
        }
        firstUserMessageContext = renderClaudeDynamicUserContext({
          environment: dynamic.environment,
          ...(dynamic.gitStatus ? { gitStatus: dynamic.gitStatus } : {}),
        })
      } else {
        messages.push({
          role: 'system',
          content: renderClaudeDynamicSystemContext(dynamic),
        })
      }
    }
    if (this.options.appendSystemPrompt !== undefined) {
      messages.push({
        role: 'system',
        content: this.options.appendSystemPrompt,
      })
    }
    return {
      systemMessages: messages,
      ...(firstUserMessageContext ? { firstUserMessageContext } : {}),
    }
  }
}
