import type { TeamMailboxPayload } from '../../core/team-mailbox.js'

const TEAM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u

export class UnsupportedClaudeTeamCompatibilityError extends Error {
  readonly code = 'UNSUPPORTED_CLAUDE_TEAM_COMPATIBILITY'
  constructor(reason: string) {
    super(`Unsupported Claude Team compatibility shape: ${reason}`)
    this.name = 'UnsupportedClaudeTeamCompatibilityError'
  }
}

export function isClaudeTeamCompatibilityError(
  error: unknown,
): error is UnsupportedClaudeTeamCompatibilityError {
  return error instanceof UnsupportedClaudeTeamCompatibilityError
}

export interface ClaudeTeamCreateCanonical {
  readonly kind: 'team.create'
  readonly teamId: string
  readonly name: string
  readonly description: string
  readonly leadAgentType: string | undefined
}
export interface ClaudeTeamDeleteCanonical {
  readonly kind: 'team.delete'
}
export interface ClaudeTeamMessageCanonical {
  readonly kind: 'team.message'
  readonly to: string | 'broadcast'
  readonly payload: TeamMailboxPayload
}
export type ClaudeTeamCanonical =
  | ClaudeTeamCreateCanonical
  | ClaudeTeamDeleteCanonical
  | ClaudeTeamMessageCanonical

function object(value: unknown, reason: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new UnsupportedClaudeTeamCompatibilityError(reason)
  return value as Record<string, unknown>
}
function strict(
  source: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (Object.keys(source).some((key) => !keys.includes(key)))
    throw new UnsupportedClaudeTeamCompatibilityError('unknown fields')
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new UnsupportedClaudeTeamCompatibilityError(
      `${field} must be nonblank`,
    )
  return value
}
function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return text(value, field)
}

export class ClaudeTeamCompatibilityAdapter {
  decodeCreate(input: unknown): ClaudeTeamCreateCanonical {
    const source = object(input, 'create must be an object')
    strict(source, ['team_name', 'description', 'agent_type'])
    const teamId = text(source.team_name, 'team_name')
    if (!TEAM_ID.test(teamId))
      throw new UnsupportedClaudeTeamCompatibilityError(
        'team_name cannot be represented as a Praxis Team ID',
      )
    return {
      kind: 'team.create',
      teamId,
      name: teamId,
      description:
        source.description === undefined
          ? ''
          : text(source.description, 'description'),
      leadAgentType: optionalText(source.agent_type, 'agent_type'),
    }
  }

  decodeDelete(input: unknown): ClaudeTeamDeleteCanonical {
    const source = object(input, 'delete must be an object')
    strict(source, [])
    return { kind: 'team.delete' }
  }

  decodeSendMessage(input: unknown): ClaudeTeamMessageCanonical {
    const source = object(input, 'send must be an object')
    strict(source, ['to', 'summary', 'message'])
    const recipient = source.to === '*' ? 'broadcast' : text(source.to, 'to')
    const summary =
      source.summary === undefined ? undefined : text(source.summary, 'summary')
    if (typeof source.message === 'string')
      return {
        kind: 'team.message',
        to: recipient,
        payload: {
          kind: 'text',
          text: text(source.message, 'message'),
          ...(summary === undefined ? {} : { summary }),
        },
      }
    const message = object(
      source.message,
      'structured message must be an object',
    )
    const type = text(message.type, 'message.type')
    if (type === 'shutdown_request') {
      strict(message, ['type', 'request_id', 'reason'])
      const requestId = text(message.request_id, 'request_id')
      return {
        kind: 'team.message',
        to: recipient,
        payload: {
          kind: 'shutdown',
          phase: 'request',
          requestId,
          ...(message.reason === undefined
            ? {}
            : { reason: text(message.reason, 'reason') }),
        },
      }
    }
    if (type === 'shutdown_response') {
      strict(message, ['type', 'request_id', 'approve', 'reason'])
      const requestId = text(message.request_id, 'request_id')
      if (typeof message.approve !== 'boolean')
        throw new UnsupportedClaudeTeamCompatibilityError(
          'shutdown response approve is required',
        )
      return {
        kind: 'team.message',
        to: recipient,
        payload: {
          kind: 'shutdown',
          phase: 'response',
          requestId,
          approved: message.approve,
          ...(message.reason === undefined
            ? {}
            : { reason: text(message.reason, 'reason') }),
        },
      }
    }
    if (type === 'plan_approval_response') {
      strict(message, ['type', 'request_id', 'approve', 'feedback'])
      const requestId = text(message.request_id, 'request_id')
      if (typeof message.approve !== 'boolean')
        throw new UnsupportedClaudeTeamCompatibilityError(
          'plan response approve is required',
        )
      return {
        kind: 'team.message',
        to: recipient,
        payload: {
          kind: 'plan',
          phase: 'response',
          requestId,
          approved: message.approve,
          ...(message.feedback === undefined
            ? {}
            : { feedback: text(message.feedback, 'feedback') }),
        },
      }
    }
    throw new UnsupportedClaudeTeamCompatibilityError(`message type ${type}`)
  }

  encodeCreateResult(result: {
    readonly teamId: string
    readonly teamFilePath?: string
    readonly leadAgentId?: string
  }): Record<string, unknown> {
    if (
      !TEAM_ID.test(result.teamId) ||
      (result.teamFilePath !== undefined &&
        typeof result.teamFilePath !== 'string') ||
      (result.leadAgentId !== undefined &&
        typeof result.leadAgentId !== 'string')
    )
      throw new UnsupportedClaudeTeamCompatibilityError('invalid create result')
    return {
      team_name: result.teamId,
      success: true,
      message: `Team ${result.teamId} created`,
      ...(result.teamFilePath === undefined
        ? {}
        : { team_file_path: result.teamFilePath }),
      ...(result.leadAgentId === undefined
        ? {}
        : { lead_agent_id: result.leadAgentId }),
    }
  }
  encodeDeleteResult(result: {
    readonly teamId: string
    readonly success: boolean
    readonly message: string
  }): Record<string, unknown> {
    if (
      !TEAM_ID.test(result.teamId) ||
      typeof result.success !== 'boolean' ||
      typeof result.message !== 'string'
    )
      throw new UnsupportedClaudeTeamCompatibilityError('invalid delete result')
    return {
      team_name: result.teamId,
      success: result.success,
      message: result.message,
    }
  }
  encodeSendResult(result: {
    readonly teamId: string
    readonly recipients: readonly string[]
    readonly success?: boolean
    readonly message?: string
  }): Record<string, unknown> {
    if (
      !TEAM_ID.test(result.teamId) ||
      !Array.isArray(result.recipients) ||
      result.recipients.some(
        (recipient) => typeof recipient !== 'string' || recipient.trim() === '',
      )
    )
      throw new UnsupportedClaudeTeamCompatibilityError('invalid send result')
    return {
      team_name: result.teamId,
      success: result.success ?? true,
      message: result.message ?? 'Message sent',
      routing: { recipients: [...result.recipients] },
    }
  }
}
