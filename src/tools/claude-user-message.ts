import { stat } from 'node:fs/promises'
import { extname, resolve } from 'node:path'

import type {
  ModelToolCall,
  ModelToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from '../core/runtime.js'
import { resolveToolSchedulingPolicy } from '../core/tool-scheduling-policy.js'

export interface UserMessage {
  message: string
  attachments: readonly string[]
  status: 'normal' | 'proactive'
}

interface AttachmentMetadata {
  path: string
  size: number
  isImage: boolean
}

const DEFINITION: ModelToolDefinition = {
  name: 'SendUserMessage',
  description:
    'Send a visible message to the user. Use this for progress updates, blockers, or completion notices when brief mode is enabled.',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The message for the user. Supports markdown formatting.',
      },
      attachments: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional file paths to show alongside the message.',
      },
      status: {
        type: 'string',
        enum: ['normal', 'proactive'],
        description: 'Whether this is a normal reply or unsolicited update.',
      },
    },
    required: ['message', 'status'],
    additionalProperties: false,
  },
}

function stringValue(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`SendUserMessage ${key} must be a non-empty string`)
  return value
}

export class ClaudeUserMessageToolRegistry implements ToolRegistry {
  constructor(
    private readonly base: ToolRegistry,
    private readonly onMessage: (message: UserMessage) => void,
  ) {}

  definitions(): readonly ModelToolDefinition[] {
    return [...this.base.definitions(), DEFINITION]
  }

  schedulingPolicy(call: ModelToolCall) {
    if (call.name === DEFINITION.name) {
      return { concurrency: 'exclusive' as const, cancelOnInterrupt: true }
    }
    return resolveToolSchedulingPolicy(this.base, call)
  }

  prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    if (call.name !== DEFINITION.name) return this.base.prepare(call, context)
    return Promise.resolve(call)
  }

  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (call.name !== DEFINITION.name) return this.base.execute(call, context)
    if (context.signal?.aborted) throw new Error('Operation cancelled')
    const input = call.input
    const rawAttachments = input.attachments
    if (
      rawAttachments !== undefined &&
      (!Array.isArray(rawAttachments) ||
        rawAttachments.some((value) => typeof value !== 'string'))
    ) {
      throw new Error('SendUserMessage attachments must be an array of strings')
    }
    if (input.status !== 'normal' && input.status !== 'proactive') {
      throw new Error('SendUserMessage status must be normal or proactive')
    }
    const message: UserMessage = {
      message: stringValue(input, 'message'),
      attachments: await Promise.all(
        ((rawAttachments as string[] | undefined) ?? []).map(async (path) => {
          const resolved = resolve(context.cwd, path)
          const info = await stat(resolved)
          if (!info.isFile())
            throw new Error(`Attachment is not a file: ${path}`)
          return resolved
        }),
      ),
      status: input.status,
    }
    this.onMessage(message)
    const attachmentMetadata: AttachmentMetadata[] = await Promise.all(
      message.attachments.map(async (path) => {
        const info = await stat(path)
        return {
          path,
          size: info.size,
          isImage: ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(
            extname(path).toLowerCase(),
          ),
        }
      }),
    )
    return {
      content: 'Message delivered to user.',
      isError: false,
      nativeToolUseResult: {
        message: message.message,
        ...(attachmentMetadata.length
          ? { attachments: attachmentMetadata }
          : {}),
        sentAt: new Date().toISOString(),
      },
    }
  }
}
