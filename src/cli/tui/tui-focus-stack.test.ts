import { describe, expect, it } from 'vitest'

import {
  currentTuiInteractionLayer,
  projectTuiFocusStack,
  type TuiFocusProjectionInput,
} from './tui-focus-stack.js'

const base: TuiFocusProjectionInput = {
  pendingPrefix: false,
  permission: false,
  planApproval: false,
  question: false,
  elicitation: false,
  selectingSession: false,
  menu: false,
  filePicker: false,
  commandPalette: false,
}

describe('projectTuiFocusStack', () => {
  it.each([
    ['pending-prefix', { pendingPrefix: true }, { kind: 'pending-prefix' }],
    [
      'permission',
      { permission: true },
      { kind: 'cancelable', target: 'permission' },
    ],
    [
      'plan-approval',
      { planApproval: true },
      { kind: 'cancelable', target: 'plan-approval' },
    ],
    ['cd-trust', { cdTrust: true }, { kind: 'cancelable', target: 'cd-trust' }],
    [
      'question',
      { question: true },
      { kind: 'cancelable', target: 'question' },
    ],
    [
      'session-picker',
      { selectingSession: true },
      { kind: 'delegated', target: 'session-picker' },
    ],
    ['menu', { menu: true }, { kind: 'delegated', target: 'menu' }],
    [
      'file-picker',
      { filePicker: true },
      { kind: 'cancelable', target: 'file-picker' },
    ],
    [
      'command-palette',
      { commandPalette: true },
      { kind: 'cancelable', target: 'command-palette' },
    ],
  ] as const)('projects %s', (id, flags, layer) => {
    const stack = projectTuiFocusStack({ ...base, ...flags })
    expect(stack.map((entry) => entry.id)).toEqual(['composer', id])
    expect(currentTuiInteractionLayer(stack)).toEqual(layer)
  })

  it.each([
    ['plain', 'elicitation', 'elicitation'],
    ['url-waiting', 'elicitation-url-waiting', 'elicitation-url-waiting'],
    ['expanded-options', 'elicitation-options', 'elicitation-options'],
  ] as const)('projects elicitation %s', (mode, id, target) => {
    const stack = projectTuiFocusStack({ ...base, elicitation: mode })
    expect(stack.at(-1)).toEqual({
      id,
      layer: { kind: 'cancelable', target },
    })
  })

  it('uses fixed precedence and immutable stable entries', () => {
    const stack = projectTuiFocusStack({
      ...base,
      commandPalette: true,
      permission: true,
    })
    expect(stack.map((entry) => entry.id)).toEqual(['composer', 'permission'])
    expect(Object.isFrozen(stack)).toBe(true)
    expect(Object.isFrozen(stack[1])).toBe(true)
    expect(projectTuiFocusStack(base)[0]).toBe(stack[0])
  })
})

describe('currentTuiInteractionLayer', () => {
  it('returns none for an empty stack', () => {
    expect(currentTuiInteractionLayer([])).toEqual({ kind: 'none' })
  })
})
