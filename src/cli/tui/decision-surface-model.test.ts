import { describe, expect, it } from 'vitest'

import type {
  ClaudePlanApprovalRequest,
  ClaudeQuestion,
} from '../../tools/claude-interactive-tools.js'
import { projectTuiDecisionSurface } from './decision-surface-model.js'

const plan = (
  overrides: Partial<ClaudePlanApprovalRequest> = {},
): ClaudePlanApprovalRequest => ({
  action: 'exit',
  planPath: '/tmp/plan.md',
  previousMode: 'plan',
  ...overrides,
})
const questions: readonly ClaudeQuestion[] = [
  {
    header: 'First',
    question: 'Pick first',
    multiSelect: false,
    options: [
      { label: 'One', description: 'one description' },
      { label: 'Two', description: '', preview: '' },
    ],
  },
  {
    header: 'Second',
    question: 'Pick second',
    multiSelect: true,
    options: [{ label: 'Three', description: 'three', preview: 'preview' }],
  },
  {
    header: 'Third',
    question: 'Pick third',
    multiSelect: false,
    options: [{ label: 'Four', description: 'four' }],
  },
]
const planModel = (
  selectedIndex: number,
  feedbackMode = false,
  feedback = '',
) => {
  const model = projectTuiDecisionSurface({
    kind: 'plan-approval',
    request: plan({ plan: 'exact plan text' }),
    selectedIndex,
    feedbackMode,
    feedback,
    elevatedMode: 'auto',
  })
  if (model.kind !== 'plan-approval') throw new Error('expected plan model')
  return model
}

describe('projectTuiDecisionSurface', () => {
  it('projects cd trust with default rejection and clamps selection', () => {
    const model = projectTuiDecisionSurface({
      kind: 'cd-trust',
      canonicalPath: '/canonical/target',
      selectedIndex: 99,
    })
    expect(model).toMatchObject({
      kind: 'cd-trust',
      heading: 'Moving to a new directory:',
      canonicalPath: '/canonical/target',
      selectedIndex: 1,
    })
    expect(
      model.options.map((option) => [option.label, option.selected]),
    ).toEqual([
      ['No, stay put', false],
      ['Yes, move here', true],
    ])
    const rejected = projectTuiDecisionSurface({
      kind: 'cd-trust',
      canonicalPath: '/canonical/target',
      selectedIndex: -1,
    })
    if (rejected.kind !== 'cd-trust') throw new Error('expected cd trust model')
    expect(rejected.selectedIndex).toBe(0)
    expect(rejected.options[0]?.selected).toBe(true)
  })
  it.each([
    [-4, 0],
    [1.9, 1],
    [99, 2],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [Number.NEGATIVE_INFINITY, 0],
  ])('normalizes plan selection %s to %s', (input, expected) => {
    const model = planModel(input)
    expect(model.selectedIndex).toBe(expected)
    expect(model.options.map((option) => option.selected)).toEqual(
      [0, 1, 2].map((index) => index === expected),
    )
    expect(model.range).toEqual({ min: 1, max: 3 })
  })

  it.each([
    [-4, 0],
    [1.9, 1],
    [99, 2],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [Number.NEGATIVE_INFINITY, 0],
  ])('normalizes question index %s to %s', (input, expected) => {
    const model = projectTuiDecisionSurface({
      kind: 'question',
      questions,
      questionIndex: input,
      answer: 'custom',
    })
    if (model.kind !== 'question') throw new Error('expected question model')
    const expectedQuestion = questions[expected]
    if (expectedQuestion === undefined)
      throw new Error('expected normalized question')
    expect(model.questionIndex).toBe(expected)
    expect(model.progress).toBe(`Question ${expected + 1} of 3`)
    expect(model.options.map((option) => option.label)).toEqual(
      expectedQuestion.options.map((option) => option.label),
    )
    expect(model.range).toEqual({
      min: 1,
      max: expectedQuestion.options.length,
    })
  })

  it('projects exact plan copy, labels, placeholders, and actions', () => {
    for (const [mode, label] of [
      ['auto', 'Yes, and use auto mode'],
      ['bypassPermissions', 'Yes, and bypass permissions'],
      ['acceptEdits', 'Yes, auto-accept edits'],
    ] as const) {
      const model = projectTuiDecisionSurface({
        kind: 'plan-approval',
        request: plan({ plan: 'exact plan text' }),
        selectedIndex: 0,
        feedbackMode: false,
        feedback: '',
        elevatedMode: mode,
      })
      if (model.kind !== 'plan-approval') throw new Error('expected plan model')
      expect(model.heading).toBe('Ready to code?')
      expect(model.intro).toBe("Here is Praxis's plan:")
      expect(model.explanation).toBe(
        'Praxis has written up a plan and is ready to execute. Would you like to proceed?',
      )
      expect(model.planPath).toBe('/tmp/plan.md')
      expect(model.plan).toBe('exact plan text')
      expect(model.options[0]?.label).toBe(label)
      expect(
        model.actions.map((action) => action.visualLabel).filter(Boolean),
      ).toEqual(['Enter to confirm', 'Tab to add feedback'])
      expect(model.actions.map((action) => action.screenReaderLabel)).toEqual([
        'Enter selection [1-3]',
        'Tab to add feedback',
        'Use up/down arrows to change selection',
        'Press 1, 2, or 3 to choose directly',
        'Press y to approve',
        'Press n to keep planning',
      ])
      expect(model.cancellation).toEqual({
        visualLabel: 'Esc to cancel',
        screenReaderLabel: 'Escape to cancel',
      })
    }
    expect(planModel(0).feedbackPlaceholder).toBe(
      'Add feedback for implementation',
    )
    expect(planModel(1).feedbackPlaceholder).toBe(
      'Add feedback for implementation',
    )
    expect(planModel(2).feedbackPlaceholder).toBe('Tell Praxis what to change')
  })

  it('projects feedback actions without selection claims and omits empty plans', () => {
    const model = planModel(2, true, 'change this')
    expect(model.feedback).toBe('change this')
    expect(model.actions).toEqual([
      { visualLabel: 'Enter to submit', screenReaderLabel: 'Enter to submit' },
      {
        visualLabel: 'Tab to collapse',
        screenReaderLabel: 'Tab to collapse feedback',
      },
    ])
    expect(
      model.actions.some((action) =>
        action.screenReaderLabel.includes('selection'),
      ),
    ).toBe(false)
    expect(
      projectTuiDecisionSurface({
        kind: 'plan-approval',
        request: plan(),
        selectedIndex: 0,
        feedbackMode: false,
        feedback: '',
        elevatedMode: 'auto',
      }),
    ).not.toHaveProperty('plan')
    expect(
      projectTuiDecisionSurface({
        kind: 'plan-approval',
        request: plan({ plan: '' }),
        selectedIndex: 0,
        feedbackMode: false,
        feedback: '',
        elevatedMode: 'auto',
      }),
    ).not.toHaveProperty('plan')
  })

  it('projects only the current question with retained option fields and truthful guidance', () => {
    const single = projectTuiDecisionSurface({
      kind: 'question',
      questions,
      questionIndex: 0,
      answer: 'custom answer',
    })
    if (single.kind !== 'question') throw new Error('expected question model')
    expect(single.heading).toBe('First: Pick first')
    expect(single.answer).toBe('custom answer')
    expect(single.options).toEqual([
      {
        index: 1,
        label: 'One',
        description: 'one description',
        selected: false,
      },
      { index: 2, label: 'Two', description: '', preview: '', selected: false },
    ])
    expect(single.guidance).toBe('Enter one option number or custom text')
    expect(single.actions).toEqual([
      {
        visualLabel: 'Enter one option number or custom text',
        screenReaderLabel: 'Enter one option number or custom text',
      },
    ])
    expect(single.cancellation).toEqual({
      visualLabel: 'Esc cancels',
      screenReaderLabel: 'Escape cancels',
    })
    const multi = projectTuiDecisionSurface({
      kind: 'question',
      questions,
      questionIndex: 1,
      answer: '',
    })
    if (multi.kind !== 'question') throw new Error('expected question model')
    expect(multi.guidance).toBe(
      'Enter comma-separated option numbers or custom text',
    )
    expect(multi.actions).toEqual([
      {
        visualLabel: 'Enter comma-separated option numbers or custom text',
        screenReaderLabel:
          'Enter comma-separated option numbers or custom text',
      },
    ])
  })

  it('projects empty questions as one stable non-interactive state', () => {
    const model = projectTuiDecisionSurface({
      kind: 'question',
      questions: [],
      questionIndex: 99,
      answer: '',
    })
    if (model.kind !== 'question') throw new Error('expected question model')
    expect(model.questionIndex).toBe(-1)
    expect(model.progress).toBe('Question 0 of 0')
    expect(model.heading).toBe('Question')
    expect(model.options).toEqual([])
    expect(model.range).toEqual({ min: 0, max: 0 })
    expect(model.guidance).toBeUndefined()
    expect(model.actions).toEqual([])
    expect(model.emptyState).toBe('No questions available.')
    expect(model.cancellation).toEqual({
      visualLabel: 'Esc cancels',
      screenReaderLabel: 'Escape cancels',
    })
  })

  it('does not mutate source requests, questions, or options', () => {
    const request = Object.freeze(plan({ plan: 'immutable plan' }))
    const requestBefore = structuredClone(request)
    const source = structuredClone(questions)
    const frozen = structuredClone(questions).map((question) =>
      Object.freeze({
        ...question,
        options: Object.freeze(
          question.options.map((option) => Object.freeze({ ...option })),
        ),
      }),
    )
    projectTuiDecisionSurface({
      kind: 'question',
      questions: Object.freeze(frozen),
      questionIndex: 1,
      answer: '',
    })
    projectTuiDecisionSurface({
      kind: 'plan-approval',
      request,
      selectedIndex: 1,
      feedbackMode: false,
      feedback: '',
      elevatedMode: 'auto',
    })
    expect(request).toEqual(requestBefore)
    expect(questions).toEqual(source)
    expect(frozen).toEqual(source)
  })
})
