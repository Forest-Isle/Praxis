import type {
  ModelToolCall,
  PermissionApproval,
  PermissionDecision,
} from '../core/runtime.js'

export interface TeamLeadDecisionRequest {
  readonly call: ModelToolCall
  readonly originalCall?: ModelToolCall
  readonly decision: PermissionDecision
  readonly teamId: string
  readonly member: string
  readonly taskId: string
  readonly generation: number
}

export interface TeamLeadDecisionSurface {
  request(
    input: TeamLeadDecisionRequest,
  ): PermissionApproval | Promise<PermissionApproval>
}

export type TeamLeadApproveTool = (
  call: ModelToolCall,
  originalCall?: ModelToolCall,
  decision?: PermissionDecision,
) => PermissionApproval | Promise<PermissionApproval>

/** Serializes Team child permission prompts while allowing later prompts after failure. */
export class SerializedTeamLeadDecisionSurface implements TeamLeadDecisionSurface {
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly approve: TeamLeadApproveTool) {}

  request(input: TeamLeadDecisionRequest): Promise<PermissionApproval> {
    const run = this.tail
      .catch(() => undefined)
      .then(() => this.approve(input.call, input.originalCall, input.decision))
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
