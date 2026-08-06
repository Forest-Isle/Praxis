import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import type {
  ModelToolCall,
  ModelToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from '../core/runtime.js'
import {
  parseWorkflowScript,
  type WorkflowManager,
  type WorkflowSource,
} from '../application/workflow-manager.js'
import type { ClaudeSubagentExecutor } from '../application/subagent-service.js'

const MAX_SCRIPT_BYTES = 524_288

const WORKFLOW_DEFINITION: ModelToolDefinition = {
  name: 'Workflow',
  description: `Run an explicitly requested, sandboxed JavaScript workflow in the background. Use only when the user asks for a workflow or named saved workflow; for ordinary delegation use Agent.

Every script starts with a pure-literal \`export const meta = { name, description, phases? }\`. Its async body may use \`args\`, \`agent(prompt, options?)\`, \`parallel(thunks)\`, \`pipeline(items, ...stages)\`, \`workflow(nameOrScriptPath, args)\`, \`phase(title)\`, \`log(message)\`, and \`budget.{total,spent(),remaining()}\`. Agent options are \`label\`, \`phase\`, \`model\`, \`effort\`, \`agentType\`, \`schema\`, and \`isolation: 'worktree'\`. Pipeline stages receive \`(previousResult, originalItem, index)\`; failed parallel or pipeline items become null. Nested workflows are limited to one level.

Provide one source: \`scriptPath\` takes precedence over \`script\`, which takes precedence over \`name\`. Saved names resolve from project then user \`.claude/workflows\`, followed by built-ins. The call returns a task ID immediately; use TaskOutput/TaskStop for lifecycle. Resume a terminal or interrupted run with its script path and \`resumeFromRunId\`; completed matching agents replay from journal. Workflows allow at most 1000 agents, 4096 collection items, and bounded concurrency. Scripts have no Node.js, filesystem, network, ambient time, or randomness.`,
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      script: { type: 'string', maxLength: MAX_SCRIPT_BYTES },
      name: { type: 'string' },
      description: { type: 'string' },
      title: { type: 'string' },
      args: {},
      scriptPath: { type: 'string' },
      resumeFromRunId: {
        type: 'string',
        pattern: '^wf_[a-z0-9-]{6,}$',
      },
    },
    additionalProperties: false,
  },
}

const DEEP_RESEARCH = `export const meta = {
  name: 'deep-research',
  description: 'Research a topic from independent angles and synthesize the evidence',
  phases: [
    { title: 'Research', detail: 'Gather independent evidence' },
    { title: 'Synthesis', detail: 'Reconcile findings and produce the answer' },
  ],
}
phase('Research')
const topic = typeof args === 'string' ? args : args.topic
if (typeof topic !== 'string' || topic.length === 0) throw new Error('deep-research requires args.topic')
const findings = await parallel([
  () => agent('Research primary sources for: ' + topic, { label: 'Primary sources', phase: 'Research' }),
  () => agent('Find counterarguments and unresolved questions for: ' + topic, { label: 'Counterevidence', phase: 'Research' }),
  () => agent('Build a concise factual timeline for: ' + topic, { label: 'Timeline', phase: 'Research' }),
])
phase('Synthesis')
return agent('Synthesize these findings into a sourced answer about ' + topic + ':\n' + JSON.stringify(findings), { label: 'Synthesis', phase: 'Synthesis' })`

const CODE_REVIEW = `export const meta = {
  name: 'code-review',
  description: 'Review a code change for correctness, security, tests, and maintainability',
  phases: [
    { title: 'Review', detail: 'Run independent focused reviews' },
    { title: 'Triage', detail: 'Deduplicate and rank actionable findings' },
  ],
}
phase('Review')
const target = typeof args === 'string' ? args : (args.target || 'current working tree changes')
const reviews = await parallel([
  () => agent('Review ' + target + ' for logic errors and edge cases. Return only actionable findings.', { label: 'Correctness', phase: 'Review' }),
  () => agent('Review ' + target + ' for security, resource, and concurrency bugs. Return only actionable findings.', { label: 'Security', phase: 'Review' }),
  () => agent('Review tests for ' + target + ' and identify behavior not actually covered.', { label: 'Test coverage', phase: 'Review' }),
])
phase('Triage')
return agent('Deduplicate and severity-rank these review findings. Keep concrete file references and fixes:\n' + JSON.stringify(reviews), { label: 'Triage', phase: 'Triage' })`

const BUILT_INS = new Map([
  ['deep-research', DEEP_RESEARCH],
  ['code-review', CODE_REVIEW],
])

export interface ClaudeWorkflowToolRegistryOptions {
  base: ToolRegistry
  manager: WorkflowManager
  executor: ClaudeSubagentExecutor
  cwd: string
  configRoot: string
  sessionId: string
  promptIdForCall(callId: string): string | null
  defaultModel: string
  tokenBudget?: number | null
  enabled: boolean
}

function optionalString(
  input: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = input[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

export class ClaudeWorkflowToolRegistry implements ToolRegistry {
  private readonly prepared = new Map<string, WorkflowSource>()

  constructor(private readonly options: ClaudeWorkflowToolRegistryOptions) {}

  definitions(): readonly ModelToolDefinition[] {
    const base = this.options.base.definitions()
    if (!this.options.enabled || base.some(({ name }) => name === 'Workflow')) {
      return base
    }
    return [...base, WORKFLOW_DEFINITION]
  }

  async prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    if (call.name === 'TaskOutput' || call.name === 'TaskStop') {
      const taskId = call.input.task_id ?? call.input.shell_id
      if (typeof taskId === 'string' && this.options.manager.has(taskId)) {
        if (call.name === 'TaskOutput') {
          const block = call.input.block ?? true
          const timeout = call.input.timeout ?? 30_000
          if (typeof block !== 'boolean')
            throw new Error('block must be a boolean')
          if (typeof timeout !== 'number' || timeout < 0 || timeout > 600_000) {
            throw new Error('timeout must be between 0 and 600000')
          }
          return { ...call, input: { task_id: taskId, block, timeout } }
        }
        return { ...call, input: { task_id: taskId } }
      }
      return this.options.base.prepare(call, context)
    }
    if (call.name !== 'Workflow')
      return this.options.base.prepare(call, context)
    if (!this.options.enabled) throw new Error('Tool Workflow is unavailable')
    const allowed = new Set([
      'script',
      'name',
      'description',
      'title',
      'args',
      'scriptPath',
      'resumeFromRunId',
    ])
    for (const key of Object.keys(call.input)) {
      if (!allowed.has(key))
        throw new Error(`Unknown Workflow input field ${key}`)
    }
    const script = optionalString(call.input, 'script')
    const name = optionalString(call.input, 'name')
    const scriptPath = optionalString(call.input, 'scriptPath')
    const description = optionalString(call.input, 'description')
    const title = optionalString(call.input, 'title')
    const resumeFromRunId = optionalString(call.input, 'resumeFromRunId')
    if (!scriptPath && !script && !name) {
      throw new Error(
        'InputValidationError: [\n  {\n    "code": "custom",\n    "path": [],\n    "message": "Must provide script, name, or scriptPath"\n  }\n]',
      )
    }
    if (resumeFromRunId && !/^wf_[a-z0-9-]{6,}$/u.test(resumeFromRunId)) {
      throw new Error('resumeFromRunId must match ^wf_[a-z0-9-]{6,}$')
    }
    const source = await this.resolveSource({
      ...(scriptPath ? { scriptPath } : {}),
      ...(script ? { script } : {}),
      ...(name ? { name } : {}),
    })
    this.prepared.set(call.id, source)
    return {
      ...call,
      input: {
        ...(scriptPath ? { scriptPath } : script ? { script } : { name }),
        ...(description ? { description } : {}),
        ...(title ? { title } : {}),
        ...(Object.hasOwn(call.input, 'args') ? { args: call.input.args } : {}),
        ...(resumeFromRunId ? { resumeFromRunId } : {}),
      },
    }
  }

  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (call.name === 'TaskOutput' || call.name === 'TaskStop') {
      const taskId = String(call.input.task_id)
      if (this.options.manager.has(taskId)) {
        return {
          content:
            call.name === 'TaskOutput'
              ? await this.options.manager.output(taskId, {
                  block: Boolean(call.input.block),
                  timeout: Number(call.input.timeout),
                })
              : this.options.manager.stop(taskId),
          isError: false,
        }
      }
      return this.options.base.execute(call, context)
    }
    if (call.name !== 'Workflow')
      return this.options.base.execute(call, context)
    const source = this.prepared.get(call.id)
    this.prepared.delete(call.id)
    if (!source) throw new Error('Workflow was not prepared')
    const launch = await this.options.manager.launch({
      sessionId: this.options.sessionId,
      promptId: this.options.promptIdForCall(call.id) ?? call.id,
      script: source.script,
      parsed: source.parsed,
      args: Object.hasOwn(call.input, 'args') ? call.input.args : undefined,
      ...(typeof call.input.resumeFromRunId === 'string'
        ? { resumeFromRunId: call.input.resumeFromRunId }
        : {}),
      defaultModel: this.options.defaultModel,
      ...(this.options.tokenBudget === undefined
        ? {}
        : { tokenBudget: this.options.tokenBudget }),
      runAgent: (agentOptions) =>
        this.options.executor.runWorkflowAgent(agentOptions),
      resolveNested: (reference) =>
        this.resolveSource(
          reference.endsWith('.js') || reference.includes('/')
            ? { scriptPath: reference }
            : { name: reference },
        ),
      ...(context.signal ? { signal: context.signal } : {}),
    })
    return {
      content: launch.content,
      isError: false,
      nativeToolUseResult: {
        isAsync: true,
        status: 'async_launched',
        taskId: launch.taskId,
        taskType: 'local_workflow',
        runId: launch.runId,
        outputFile: launch.transcriptDirectory,
      },
    }
  }

  private async resolveSource(input: {
    scriptPath?: string
    script?: string
    name?: string
  }): Promise<WorkflowSource> {
    if (input.scriptPath) {
      const path = isAbsolute(input.scriptPath)
        ? input.scriptPath
        : resolve(this.options.cwd, input.scriptPath)
      let script: string
      try {
        script = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`Workflow script file not found: ${path}`)
        }
        throw error
      }
      return this.source(script)
    }
    if (input.script) return this.source(input.script)
    const name = String(input.name)
    for (const path of [
      resolve(this.options.cwd, '.claude', 'workflows', `${name}.js`),
      resolve(this.options.configRoot, 'workflows', `${name}.js`),
    ]) {
      try {
        return this.source(await readFile(path, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const builtIn = BUILT_INS.get(name)
    if (builtIn) return this.source(builtIn)
    const available = [...BUILT_INS.keys()].join(', ')
    throw new Error(`Workflow "${name}" not found. Available: ${available}`)
  }

  private source(script: string): WorkflowSource {
    if (Buffer.byteLength(script) > MAX_SCRIPT_BYTES) {
      throw new Error(`Workflow script exceeded ${MAX_SCRIPT_BYTES} bytes`)
    }
    return {
      script,
      parsed: parseWorkflowScript(script),
    }
  }
}
