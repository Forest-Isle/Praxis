import { resolve } from 'node:path'

import type {
  ModelToolCall,
  ModelToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from '../core/runtime.js'
import {
  BackgroundBashManager,
  type BackgroundBashToolResult,
} from '../application/background-bash-manager.js'
import { isBackgroundBashTaskId } from '../application/background-task-id.js'
import {
  ClaudeTaskStore,
  type ClaudeTask,
  type ClaudeTaskCreateInput,
  type ClaudeTaskStatus,
  type ClaudeTaskUpdateInput,
} from '../persistence/claude-task-store.js'

const SCHEMA = 'https://json-schema.org/draft/2020-12/schema'

const TASK_DEFINITIONS: readonly ModelToolDefinition[] = [
  {
    name: 'TaskCreate',
    description:
      'Create a structured task for the current coding session. Tasks start with pending status.',
    inputSchema: {
      $schema: SCHEMA,
      type: 'object',
      properties: {
        subject: { description: 'A brief title for the task', type: 'string' },
        description: { description: 'What needs to be done', type: 'string' },
        activeForm: {
          description:
            'Present continuous form shown in spinner when in_progress (e.g., "Running tests")',
          type: 'string',
        },
        metadata: {
          description: 'Arbitrary metadata to attach to the task',
          type: 'object',
          propertyNames: { type: 'string' },
          additionalProperties: {},
        },
      },
      required: ['subject', 'description'],
      additionalProperties: false,
    },
  },
  {
    name: 'TaskGet',
    description: 'Retrieve full task details by ID from the task list.',
    inputSchema: {
      $schema: SCHEMA,
      type: 'object',
      properties: {
        taskId: {
          description: 'The ID of the task to retrieve',
          type: 'string',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'TaskList',
    description: 'List all tasks with status, owner, and active blockers.',
    inputSchema: {
      $schema: SCHEMA,
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'TaskOutput',
    description:
      'Retrieves output from a running or completed background task. Use block=false for a non-blocking status check.',
    inputSchema: {
      $schema: SCHEMA,
      type: 'object',
      properties: {
        task_id: {
          description: 'The task ID to get output from',
          type: 'string',
        },
        block: {
          description: 'Whether to wait for completion',
          default: true,
          type: 'boolean',
        },
        timeout: {
          description: 'Max wait time in ms',
          default: 30000,
          type: 'number',
          minimum: 0,
          maximum: 600000,
        },
      },
      required: ['task_id', 'block', 'timeout'],
      additionalProperties: false,
    },
  },
  {
    name: 'TaskStop',
    description: 'Stops a running background task by its ID.',
    inputSchema: {
      $schema: SCHEMA,
      type: 'object',
      properties: {
        task_id: {
          description:
            'The ID of the background task to stop. Agent-team teammates and named background agents are also accepted by agent ID or name.',
          type: 'string',
        },
        shell_id: {
          description: 'Deprecated: use task_id instead',
          type: 'string',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'TaskUpdate',
    description:
      'Update task status, details, owner, metadata, or dependencies. Setting status to deleted permanently removes the task.',
    inputSchema: {
      $schema: SCHEMA,
      type: 'object',
      properties: {
        taskId: {
          description: 'The ID of the task to update',
          type: 'string',
        },
        subject: { description: 'New subject for the task', type: 'string' },
        description: {
          description: 'New description for the task',
          type: 'string',
        },
        activeForm: {
          description:
            'Present continuous form shown in spinner when in_progress (e.g., "Running tests")',
          type: 'string',
        },
        status: {
          description: 'New status for the task',
          anyOf: [
            {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
            },
            { type: 'string', const: 'deleted' },
          ],
        },
        addBlocks: {
          description: 'Task IDs that this task blocks',
          type: 'array',
          items: { type: 'string' },
        },
        addBlockedBy: {
          description: 'Task IDs that block this task',
          type: 'array',
          items: { type: 'string' },
        },
        owner: { description: 'New owner for the task', type: 'string' },
        metadata: {
          description:
            'Metadata keys to merge into the task. Set a key to null to delete it.',
          type: 'object',
          propertyNames: { type: 'string' },
          additionalProperties: {},
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
]

export interface ClaudeTaskToolRegistryOptions {
  base: ToolRegistry
  cwd: string
  cwdProvider?: () => string
  praxisRoot: string
  sessionId: string
  taskRoot: string
  enabledTools?: readonly string[]
  maxOutputBytes?: number
}

function stringField(
  input: Record<string, unknown>,
  name: string,
  allowEmpty = false,
): string {
  const value = input[name]
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`${name} must be a${allowEmpty ? '' : ' non-empty'} string`)
  }
  return value
}

function optionalString(
  input: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = input[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}

function optionalObject(
  input: Record<string, unknown>,
  name: string,
): Record<string, unknown> | undefined {
  const value = input[name]
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function optionalStringArray(
  input: Record<string, unknown>,
  name: string,
): string[] | undefined {
  const value = input[name]
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw new Error(`${name} must be an array of strings`)
  }
  return value
}

function taskView(task: ClaudeTask) {
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: task.status,
    blocks: task.blocks,
    blockedBy: task.blockedBy,
  }
}

function formatTask(task: ClaudeTask): string {
  return [
    `Task #${task.id}: ${task.subject}`,
    `Status: ${task.status}`,
    `Description: ${task.description}`,
    ...(task.blockedBy.length > 0
      ? [`Blocked by: ${task.blockedBy.map((id) => `#${id}`).join(', ')}`]
      : []),
    ...(task.blocks.length > 0
      ? [`Blocks: ${task.blocks.map((id) => `#${id}`).join(', ')}`]
      : []),
  ].join('\n')
}

function toToolResult(result: BackgroundBashToolResult): ToolExecutionResult {
  return { ...result, isError: false }
}

export class ClaudeTaskToolRegistry implements ToolRegistry {
  private readonly store: ClaudeTaskStore
  private readonly background: BackgroundBashManager
  private readonly enabledTools: ReadonlySet<string> | null

  constructor(private readonly options: ClaudeTaskToolRegistryOptions) {
    this.enabledTools = options.enabledTools
      ? new Set(options.enabledTools)
      : null
    this.store = new ClaudeTaskStore({
      taskRoot: options.taskRoot,
    })
    this.background = new BackgroundBashManager({
      cwd: options.cwd,
      ...(options.cwdProvider ? { cwdProvider: options.cwdProvider } : {}),
      sessionId: options.sessionId,
      stateRoot: resolve(options.praxisRoot, 'background-tasks'),
      ...(options.maxOutputBytes === undefined
        ? {}
        : { maxOutputBytes: options.maxOutputBytes }),
    })
  }

  isEnabled(name: string): boolean {
    return this.enabledTools?.has(name) ?? true
  }

  definitions(): readonly ModelToolDefinition[] {
    const base = this.options.base
      .definitions()
      .map((definition) =>
        definition.name === 'Bash'
          ? this.bashDefinition(definition)
          : definition,
      )
    const existing = new Set(base.map(({ name }) => name))
    return [
      ...base,
      ...TASK_DEFINITIONS.filter(
        ({ name }) => this.isEnabled(name) && !existing.has(name),
      ),
    ]
  }

  async prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    if (call.name === 'Bash') {
      return this.prepareBash(call, context)
    }
    if (!TASK_DEFINITIONS.some(({ name }) => name === call.name)) {
      return this.options.base.prepare(call, context)
    }
    if (!this.isEnabled(call.name))
      throw new Error(`Tool ${call.name} is unavailable`)
    switch (call.name) {
      case 'TaskCreate':
        return { ...call, input: { ...this.createInput(call.input) } }
      case 'TaskGet':
        return { ...call, input: { taskId: stringField(call.input, 'taskId') } }
      case 'TaskList':
        if (Object.keys(call.input).length > 0) {
          throw new Error('TaskList does not accept input fields')
        }
        return { ...call, input: {} }
      case 'TaskUpdate':
        return { ...call, input: { ...this.updateInput(call.input) } }
      case 'TaskOutput': {
        const taskId = stringField(call.input, 'task_id')
        const block = call.input.block ?? true
        const timeout = call.input.timeout ?? 30_000
        if (typeof block !== 'boolean')
          throw new Error('block must be a boolean')
        if (typeof timeout !== 'number' || timeout < 0 || timeout > 600_000) {
          throw new Error('timeout must be between 0 and 600000')
        }
        if (!isBackgroundBashTaskId(taskId)) {
          return this.options.base.prepare(call, context)
        }
        return { ...call, input: { task_id: taskId, block, timeout } }
      }
      case 'TaskStop': {
        const taskId = call.input.task_id ?? call.input.shell_id
        if (typeof taskId !== 'string' || taskId.length === 0) {
          throw new Error('task_id must be a non-empty string')
        }
        if (!isBackgroundBashTaskId(taskId)) {
          return this.options.base.prepare(call, context)
        }
        return { ...call, input: { task_id: taskId } }
      }
      default:
        throw new Error(`Unknown task tool ${call.name}`)
    }
  }

  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (call.name === 'Bash') {
      if (call.input.run_in_background === true) {
        const launch = await this.background.launch({
          command: stringField(call.input, 'command'),
          description:
            optionalString(call.input, 'description') ??
            stringField(call.input, 'command'),
          toolUseId: call.id,
          timeout: Number(call.input.timeout),
          ...(context.signal ? { signal: context.signal } : {}),
        })
        return {
          content: launch.content,
          isError: false,
          nativeToolUseResult: launch.nativeToolUseResult,
        }
      }
      return this.options.base.execute(this.baseBashCall(call), context)
    }
    switch (call.name) {
      case 'TaskCreate': {
        const task = await this.store.create(this.createInput(call.input))
        return {
          content: `Task #${task.id} created successfully: ${task.subject}`,
          isError: false,
          nativeToolUseResult: { task: { id: task.id, subject: task.subject } },
        }
      }
      case 'TaskGet': {
        const task = await this.store.get(stringField(call.input, 'taskId'))
        return {
          content: task ? formatTask(task) : 'Task not found',
          isError: false,
          nativeToolUseResult: { task: task ? taskView(task) : null },
        }
      }
      case 'TaskList': {
        const tasks = await this.store.listSummaries()
        return {
          content:
            tasks.length === 0
              ? 'No tasks found'
              : tasks
                  .map(
                    (task) =>
                      `#${task.id} [${task.status}] ${task.subject}${
                        task.owner ? ` (${task.owner})` : ''
                      }${
                        task.blockedBy.length > 0
                          ? ` [blocked by ${task.blockedBy
                              .map((id) => `#${id}`)
                              .join(', ')}]`
                          : ''
                      }`,
                  )
                  .join('\n'),
          isError: false,
          nativeToolUseResult: { tasks },
        }
      }
      case 'TaskUpdate': {
        const id = stringField(call.input, 'taskId')
        const result = await this.store.update(id, this.updateInput(call.input))
        const missing = {
          success: false,
          taskId: id,
          updatedFields: [],
          error: `Task ${id} not found`,
        }
        return {
          content: result
            ? `Updated task #${id}${
                result.updatedFields.length > 0
                  ? ` ${result.updatedFields.join(', ')}`
                  : ''
              }`
            : 'Task not found',
          isError: false,
          nativeToolUseResult: result ? { ...result } : missing,
        }
      }
      case 'TaskOutput': {
        const id = stringField(call.input, 'task_id')
        if (!isBackgroundBashTaskId(id)) {
          return this.options.base.execute(call, context)
        }
        return toToolResult(
          await this.background.output(id, {
            block: Boolean(call.input.block),
            timeout: Number(call.input.timeout),
          }),
        )
      }
      case 'TaskStop': {
        const id = stringField(call.input, 'task_id')
        if (!isBackgroundBashTaskId(id)) {
          return this.options.base.execute(call, context)
        }
        return toToolResult(await this.background.stop(id))
      }
      default:
        return this.options.base.execute(call, context)
    }
  }

  notifications(waitForRunning: boolean): Promise<string[]> {
    return this.background.notifications(waitForRunning)
  }

  private bashDefinition(base: ModelToolDefinition): ModelToolDefinition {
    return {
      ...base,
      inputSchema: {
        $schema: SCHEMA,
        type: 'object',
        properties: {
          command: { description: 'The command to execute', type: 'string' },
          timeout: {
            description: 'Optional timeout in milliseconds (max 600000)',
            type: 'number',
          },
          description: {
            description:
              'Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.\n\nFor simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):\n- ls → "List files in current directory"\n- git status → "Show working tree status"\n- npm install → "Install package dependencies"\n\nFor commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:\n- find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"\n- git reset --hard origin/main → "Discard all local changes and match remote main"\n- curl -s url | jq \'.data[]\' → "Fetch JSON from URL and extract data array elements"',
            type: 'string',
          },
          run_in_background: {
            description: 'Set to true to run this command in the background.',
            type: 'boolean',
          },
          dangerouslyDisableSandbox: {
            description:
              'Set this to true to dangerously override sandbox mode and run commands without sandboxing.',
            type: 'boolean',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    }
  }

  private async prepareBash(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    const description = optionalString(call.input, 'description')
    const runInBackground = call.input.run_in_background ?? false
    const disableSandbox = call.input.dangerouslyDisableSandbox
    if (typeof runInBackground !== 'boolean') {
      throw new Error('run_in_background must be a boolean')
    }
    if (disableSandbox !== undefined && typeof disableSandbox !== 'boolean') {
      throw new Error('dangerouslyDisableSandbox must be a boolean')
    }
    const base = await this.options.base.prepare(
      this.baseBashCall(call),
      context,
    )
    return {
      ...call,
      input: {
        ...base.input,
        ...(description === undefined ? {} : { description }),
        ...(runInBackground ? { run_in_background: true } : {}),
        ...(disableSandbox === undefined
          ? {}
          : { dangerouslyDisableSandbox: disableSandbox }),
      },
    }
  }

  private baseBashCall(call: ModelToolCall): ModelToolCall {
    return {
      ...call,
      input: {
        command: stringField(call.input, 'command'),
        ...(call.input.timeout === undefined
          ? {}
          : { timeout: call.input.timeout }),
      },
    }
  }

  private createInput(input: Record<string, unknown>): ClaudeTaskCreateInput {
    const activeForm = optionalString(input, 'activeForm')
    const metadata = optionalObject(input, 'metadata')
    return {
      subject: stringField(input, 'subject'),
      description: stringField(input, 'description'),
      ...(activeForm === undefined ? {} : { activeForm }),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }

  private updateInput(input: Record<string, unknown>): ClaudeTaskUpdateInput & {
    taskId?: string
  } {
    const taskId = stringField(input, 'taskId')
    const subject = optionalString(input, 'subject')
    const description = optionalString(input, 'description')
    const activeForm = optionalString(input, 'activeForm')
    const owner = optionalString(input, 'owner')
    const addBlocks = optionalStringArray(input, 'addBlocks')
    const addBlockedBy = optionalStringArray(input, 'addBlockedBy')
    const metadata = optionalObject(input, 'metadata')
    const status = input.status
    if (
      status !== undefined &&
      !['pending', 'in_progress', 'completed', 'deleted'].includes(
        String(status),
      )
    ) {
      throw new Error(
        'status must be pending, in_progress, completed, or deleted',
      )
    }
    return {
      taskId,
      ...(subject === undefined ? {} : { subject }),
      ...(description === undefined ? {} : { description }),
      ...(activeForm === undefined ? {} : { activeForm }),
      ...(status === undefined
        ? {}
        : { status: status as ClaudeTaskStatus | 'deleted' }),
      ...(addBlocks === undefined ? {} : { addBlocks }),
      ...(addBlockedBy === undefined ? {} : { addBlockedBy }),
      ...(owner === undefined ? {} : { owner }),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
}
