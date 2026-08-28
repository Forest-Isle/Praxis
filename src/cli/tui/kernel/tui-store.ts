/** Framework-free state store for the interactive TUI. */

import {
  createTuiRuntimeKernelState,
  reduceTuiRuntimeKernel,
  type TuiRuntimeKernelAction,
  type TuiRuntimeKernelState,
} from './tui-runtime-kernel.js'

export interface TuiStoreState extends TuiRuntimeKernelState {
  readonly composer: {
    readonly text: string
    readonly cursor: number
  }
}

export type TuiStoreAction =
  | TuiRuntimeKernelAction
  | {
      readonly type: 'set-composer'
      readonly text: string
      readonly cursor?: number
    }

export interface TuiStoreInitialState extends Partial<TuiRuntimeKernelState> {
  readonly composer?: {
    readonly text?: string
    readonly cursor?: number
  }
}

function normalizeCursor(text: string, cursor: number | undefined): number {
  if (cursor === undefined || !Number.isFinite(cursor) || cursor < 0) return 0
  return Math.min(cursor, text.length)
}

export function createTuiStoreState(
  initial: TuiStoreInitialState = {},
): TuiStoreState {
  const runtime = createTuiRuntimeKernelState(initial)
  const text = initial.composer?.text ?? ''
  return {
    ...runtime,
    composer: {
      text,
      cursor: normalizeCursor(text, initial.composer?.cursor),
    },
  }
}

export function reduceTuiStore(
  state: TuiStoreState,
  action: TuiStoreAction,
): TuiStoreState {
  if (action.type === 'set-composer') {
    const cursor = normalizeCursor(action.text, action.cursor)
    if (state.composer.text === action.text && state.composer.cursor === cursor)
      return state
    return { ...state, composer: { text: action.text, cursor } }
  }

  const runtimeState: TuiRuntimeKernelState = {
    busy: state.busy,
    status: state.status,
    activeText: state.activeText,
    activeThinking: state.activeThinking,
  }
  const nextRuntime = reduceTuiRuntimeKernel(runtimeState, action)
  if (nextRuntime === runtimeState) return state
  return { ...nextRuntime, composer: state.composer }
}
