import { isAbsolute, matchesGlob, relative, resolve, sep } from 'node:path'
import { realpath } from 'node:fs/promises'

import type {
  ContextAssembler,
  ContextAssemblyOptions,
  ContextSnapshot,
  ContextInvalidationOptions,
} from '../core/context.js'
import { PromptComposer, type PromptSection } from '../core/prompt-composer.js'
import { boundProjectMemoryIndex } from '../core/project-memory.js'
import {
  renderClaudeDynamicSystemContext,
  renderClaudeDynamicUserContext,
  type ClaudeDynamicContextSections,
} from './dynamic-context.js'
import type {
  ConditionalRule,
  ContextResources,
  TextResource,
} from '../core/resources.js'

type ClaudeContextResources = ContextResources
type ClaudeConditionalRule = ConditionalRule
type ClaudeTextResource = TextResource

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
    content: boundProjectMemoryIndex(resource.content),
  }
}

export interface ClaudeContextAssemblerOptions {
  loadResources(cwd?: string): Promise<ClaudeContextResources>
  onInstructionsLoaded?(
    resources: readonly ClaudeTextResource[],
    context: {
      lifecycleId?: string
      cwd?: string
      reason: 'session_start' | 'compact' | 'resource_reload'
    },
  ): Promise<void>
  loadDynamicContext?(cwd?: string): Promise<ClaudeDynamicContextSections>
  loadMcpInstructions?(): Promise<readonly ClaudeMcpInstruction[]>
  loadSessionGuidance?(): Promise<string | undefined>
  excludeDynamicSystemPromptSections?: boolean
  systemPrompt?: string
  appendSystemPrompt?: string
  bare?: boolean
  now?(): Date
}

export interface ClaudeMcpInstruction {
  server: string
  instructions: string
}

interface ClaudeLoaderSnapshot {
  lifecycleId: string
  cwd?: string
  resources?: Promise<ClaudeContextResources>
  dynamic?: Promise<ClaudeDynamicContextSections>
  mcpInstructions?: Promise<readonly ClaudeMcpInstruction[]>
  sessionGuidance?: Promise<string | undefined>
  currentDate?: string
  resourceLoadReason?: 'compact' | 'resource_reload'
}

export type ClaudeConditionalRuleResolverOptions = ClaudeContextAssemblerOptions

export class ClaudeConditionalRuleResolver {
  constructor(private readonly options: ClaudeConditionalRuleResolverOptions) {}

  async resolve(
    filePath: string,
    attachedRulePaths: readonly string[] = [],
  ): Promise<readonly ClaudeConditionalRule[]> {
    const canonicalize = async (path: string): Promise<string> => {
      try {
        return await realpath(path)
      } catch {
        return resolve(path)
      }
    }
    const absoluteFilePath = await canonicalize(filePath)
    const attached = new Set(attachedRulePaths)
    const resources = await this.options.loadResources()
    const matches = await Promise.all(
      resources.conditionalRules.map(async (rule) => {
        if (attached.has(rule.path)) return null
        const pathFromBase = relative(
          await canonicalize(rule.baseDirectory),
          absoluteFilePath,
        )
        if (
          pathFromBase === '' ||
          pathFromBase === '..' ||
          pathFromBase.startsWith(`..${sep}`) ||
          isAbsolute(pathFromBase)
        ) {
          return null
        }
        const rulePath = pathFromBase.split(sep).join('/')
        return rule.globs.some((glob) =>
          matchesGlob(rulePath, glob.replace(/^\.\//, '')),
        )
          ? rule
          : null
      }),
    )
    return matches.filter(
      (rule): rule is ClaudeConditionalRule => rule !== null,
    )
  }
}

export class ClaudeContextAssembler implements ContextAssembler {
  private readonly composer = new PromptComposer()
  private readonly snapshots = new Map<string, ClaudeLoaderSnapshot>()

  constructor(private readonly options: ClaudeContextAssemblerOptions) {}

  async assemble(
    options: ContextAssemblyOptions = {},
  ): Promise<ContextSnapshot> {
    const snapshot = this.snapshot(options)
    const mode =
      options.mode ??
      (this.options.systemPrompt !== undefined
        ? 'custom'
        : this.options.bare
          ? 'bare'
          : 'default')
    const resources =
      mode === 'bare'
        ? { instructions: [], conditionalRules: [], memoryIndex: null }
        : await this.loadResources(snapshot, options.cwd)
    const sections = [
      renderResources('Instructions', resources.instructions),
      renderResources(
        'Auto-memory',
        resources.memoryIndex ? [limitMemoryIndex(resources.memoryIndex)] : [],
      ),
    ].filter((section): section is string => section !== null)
    const sessionSections: PromptSection[] = []
    if (sections.length > 0) {
      sessionSections.push({
        id: 'shared-resources',
        placement: 'system',
        stability: 'session',
        content: `# Shared Claude context

Instructions are ordered from broadest to most specific. Auto-memory is background context and does not override instructions.

${sections.join('\n\n')}`,
      })
    }
    const tailSections: PromptSection[] = []
    if (mode !== 'bare') {
      sessionSections.push({
        id: 'current-date',
        placement: 'system',
        stability: 'session',
        content: `# Current date\n${this.currentDate(snapshot)}`,
      })
    }
    if (mode !== 'bare') {
      const guidance = await this.loadSessionGuidance(snapshot)
      if (guidance?.trim()) {
        sessionSections.push({
          id: 'session-guidance',
          placement: 'system',
          stability: 'session',
          content: guidance,
        })
      }
      const mcpInstructions = await this.loadMcpInstructions(snapshot)
      tailSections.push(
        ...mcpInstructions
          .filter(({ instructions }) => instructions.trim().length > 0)
          .sort((left, right) => left.server.localeCompare(right.server))
          .map(({ server, instructions }) => ({
            id: `mcp-instructions:${server}`,
            placement: 'system' as const,
            stability: 'volatile' as const,
            content: `# MCP server instructions: ${server}\n${instructions.trimEnd()}`,
          })),
      )
    }
    if (mode !== 'bare' && this.options.loadDynamicContext !== undefined) {
      const dynamic = await this.loadDynamicContext(snapshot, options.cwd)
      if (this.options.excludeDynamicSystemPromptSections) {
        if (dynamic.memory) {
          sessionSections.push({
            id: 'memory-mechanics',
            placement: 'system',
            stability: 'session',
            content: dynamic.memory,
          })
        }
        tailSections.push({
          id: 'relocated-runtime-context',
          placement: 'first-user',
          stability: 'session',
          content: renderClaudeDynamicUserContext({
            environment: dynamic.environment,
            ...(dynamic.gitStatus ? { gitStatus: dynamic.gitStatus } : {}),
          }),
        })
      } else {
        sessionSections.push({
          id: 'runtime-context',
          placement: 'system',
          stability: 'session',
          content: renderClaudeDynamicSystemContext(dynamic),
        })
      }
    }
    const composition = this.composer.compose({
      mode,
      ...(options.baseSystemPrompt !== undefined
        ? { baseSystemPrompt: options.baseSystemPrompt }
        : this.options.systemPrompt !== undefined
          ? { baseSystemPrompt: this.options.systemPrompt }
          : {}),
      ...(this.options.appendSystemPrompt !== undefined
        ? { appendSystemPrompt: this.options.appendSystemPrompt }
        : {}),
      sessionSections,
      tailSections,
      ...(options.turn === undefined ? {} : { turn: options.turn }),
    })
    return composition
  }

  invalidate(options: ContextInvalidationOptions): void {
    for (const [key, snapshot] of this.snapshots) {
      if (
        options.lifecycleId !== undefined &&
        snapshot.lifecycleId !== options.lifecycleId
      )
        continue
      if (
        options.reason === 'resource-reload' ||
        options.reason === 'compact'
      ) {
        delete snapshot.resources
        snapshot.resourceLoadReason =
          options.reason === 'compact' ? 'compact' : 'resource_reload'
        continue
      }
      if (options.reason === 'tool-pool') {
        delete snapshot.mcpInstructions
        delete snapshot.sessionGuidance
        continue
      }
      this.snapshots.delete(key)
    }
  }

  private snapshot(
    options: ContextAssemblyOptions,
  ): ClaudeLoaderSnapshot | undefined {
    if (!options.lifecycleId) return undefined
    const key = JSON.stringify([options.lifecycleId, options.cwd ?? null])
    let snapshot = this.snapshots.get(key)
    if (!snapshot) {
      snapshot = {
        lifecycleId: options.lifecycleId,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      }
      this.snapshots.set(key, snapshot)
    }
    return snapshot
  }

  private loadResources(
    snapshot: ClaudeLoaderSnapshot | undefined,
    cwd: string | undefined,
  ): Promise<ClaudeContextResources> {
    if (!snapshot) return this.options.loadResources(cwd)
    if (!snapshot.resources) {
      const reason = snapshot.resourceLoadReason ?? 'session_start'
      delete snapshot.resourceLoadReason
      const pending = this.options
        .loadResources(cwd)
        .then(async (resources) => {
          await this.options.onInstructionsLoaded?.(resources.instructions, {
            lifecycleId: snapshot.lifecycleId,
            ...(cwd === undefined ? {} : { cwd }),
            reason,
          })
          return resources
        })
      snapshot.resources = pending
      void pending.catch(() => {
        if (snapshot.resources === pending) delete snapshot.resources
      })
    }
    return snapshot.resources
  }

  private loadDynamicContext(
    snapshot: ClaudeLoaderSnapshot | undefined,
    cwd: string | undefined,
  ): Promise<ClaudeDynamicContextSections> {
    const load = this.options.loadDynamicContext
    if (!load) throw new Error('Dynamic context loader is unavailable')
    if (!snapshot) return load(cwd)
    if (!snapshot.dynamic) {
      const pending = load(cwd)
      snapshot.dynamic = pending
      void pending.catch(() => {
        if (snapshot.dynamic === pending) delete snapshot.dynamic
      })
    }
    return snapshot.dynamic
  }

  private loadMcpInstructions(
    snapshot: ClaudeLoaderSnapshot | undefined,
  ): Promise<readonly ClaudeMcpInstruction[]> {
    const load = this.options.loadMcpInstructions
    if (!load) return Promise.resolve([])
    if (!snapshot) return load()
    if (!snapshot.mcpInstructions) {
      const pending = load()
      snapshot.mcpInstructions = pending
      void pending.catch(() => {
        if (snapshot.mcpInstructions === pending)
          delete snapshot.mcpInstructions
      })
    }
    return snapshot.mcpInstructions
  }

  private loadSessionGuidance(
    snapshot: ClaudeLoaderSnapshot | undefined,
  ): Promise<string | undefined> {
    const load = this.options.loadSessionGuidance
    if (!load) return Promise.resolve(undefined)
    if (!snapshot) return load()
    if (!snapshot.sessionGuidance) {
      const pending = load()
      snapshot.sessionGuidance = pending
      void pending.catch(() => {
        if (snapshot.sessionGuidance === pending)
          delete snapshot.sessionGuidance
      })
    }
    return snapshot.sessionGuidance
  }

  private currentDate(snapshot: ClaudeLoaderSnapshot | undefined): string {
    if (snapshot?.currentDate) return snapshot.currentDate
    const now = (this.options.now ?? (() => new Date()))()
    const date = [
      String(now.getFullYear()).padStart(4, '0'),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-')
    if (snapshot) snapshot.currentDate = date
    return date
  }
}
