/** Framework-free runtime state reducer for the interactive TUI. */

export interface TuiRuntimeKernelState {
  readonly busy: boolean
  readonly status: string
  readonly activeText: string
  readonly activeThinking: string
}

export type TuiRuntimeKernelAction =
  | { readonly type: 'set-busy'; readonly busy: boolean }
  | { readonly type: 'set-status'; readonly status: string }
  | {
      readonly type: 'publish-stream-frame'
      readonly text: string
      readonly thinking: string
    }
  | { readonly type: 'reset-stream' }

export function createTuiRuntimeKernelState(
  initial: Partial<TuiRuntimeKernelState> = {},
): TuiRuntimeKernelState {
  return {
    busy: initial.busy ?? false,
    status: initial.status ?? 'ready',
    activeText: initial.activeText ?? '',
    activeThinking: initial.activeThinking ?? '',
  }
}

export function reduceTuiRuntimeKernel(
  state: TuiRuntimeKernelState,
  action: TuiRuntimeKernelAction,
): TuiRuntimeKernelState {
  switch (action.type) {
    case 'set-busy':
      return state.busy === action.busy
        ? state
        : { ...state, busy: action.busy }
    case 'set-status':
      return state.status === action.status
        ? state
        : { ...state, status: action.status }
    case 'publish-stream-frame':
      return state.activeText === action.text &&
        state.activeThinking === action.thinking
        ? state
        : {
            ...state,
            activeText: action.text,
            activeThinking: action.thinking,
          }
    case 'reset-stream':
      return state.activeText === '' && state.activeThinking === ''
        ? state
        : { ...state, activeText: '', activeThinking: '' }
  }
}
