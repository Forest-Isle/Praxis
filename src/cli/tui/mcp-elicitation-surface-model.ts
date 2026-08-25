import type { CliElicitationRequest } from '../protocol.js'
import {
  createTuiElicitationForm,
  type TuiElicitationFormState,
} from './mcp-elicitation.js'

export type TuiElicitationSurfaceModel =
  | {
      readonly kind: 'elicitation-url'
      readonly serverName: string
      readonly message: string
      readonly url: string
      readonly waiting: boolean
      readonly actionLabel: string
      readonly selection: 0 | 1
    }
  | {
      readonly kind: 'elicitation-form'
      readonly serverName: string
      readonly message: string
      readonly state: TuiElicitationFormState
      readonly input: string
      readonly maxVisibleFields: number
    }

export interface TuiElicitationSurfaceInput {
  readonly request: CliElicitationRequest
  readonly form?: TuiElicitationFormState | null
  readonly input: string
  readonly urlWaiting: boolean
  readonly viewportRows?: number
}

export function projectTuiElicitationSurface({
  request,
  form,
  input,
  urlWaiting,
  viewportRows,
}: TuiElicitationSurfaceInput): TuiElicitationSurfaceModel {
  if (request.mode === 'url') {
    return {
      kind: 'elicitation-url',
      serverName: request.serverName,
      message: request.message,
      url: request.url ?? '',
      waiting: urlWaiting,
      actionLabel: request.elicitationId
        ? 'Skip confirmation'
        : 'Continue without waiting',
      selection: (form?.focusIndex === 1 ? 1 : 0) as 0 | 1,
    }
  }
  return {
    kind: 'elicitation-form',
    serverName: request.serverName,
    message: request.message,
    state: form ?? createTuiElicitationForm(request.requestedSchema),
    input,
    maxVisibleFields: Math.max(2, Math.floor(((viewportRows ?? 24) - 14) / 3)),
  }
}
