import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { DecisionSurface } from './decision-surface.js'
import { projectTuiDecisionSurface } from './decision-surface-model.js'
import { TuiThemeProvider } from './theme.js'

afterEach(cleanup)

const plan = (selectedIndex = 0, feedbackMode = false, feedback = '') =>
  projectTuiDecisionSurface({
    kind: 'plan-approval',
    request: {
      action: 'exit',
      planPath: '/tmp/plan.md',
      previousMode: 'plan',
      plan: 'Do the work',
    },
    selectedIndex,
    feedbackMode,
    feedback,
    elevatedMode: 'auto',
  })

function frame(
  model: Parameters<typeof DecisionSurface>[0]['model'],
  screenReader: boolean,
  width = 20,
) {
  const previousNoColor = process.env.NO_COLOR
  delete process.env.NO_COLOR
  try {
    return (
      render(
        <TuiThemeProvider
          settings={{ theme: 'auto', syntaxHighlightingDisabled: false }}
        >
          <DecisionSurface
            model={model}
            width={width}
            screenReader={screenReader}
          />
        </TuiThemeProvider>,
      ).lastFrame() ?? ''
    )
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = previousNoColor
  }
}

describe('DecisionSurface', () => {
  it('renders cwd trust visually and with complete screen-reader semantics', () => {
    const model = projectTuiDecisionSurface({
      kind: 'cd-trust',
      canonicalPath: '/canonical/next',
      selectedIndex: 0,
    })
    const visual = frame(model, false, 80)
    expect(visual).toContain('Moving to a new directory:')
    expect(visual).toContain('/canonical/next')
    expect(visual).toContain('read, edit, and execute files')
    expect(visual).toContain(
      'Security guide: https://code.claude.com/docs/en/security',
    )
    expect(visual).toContain('❯ 1. No, stay put')
    expect(visual).toContain('2. Yes, move here')
    expect(visual).toContain('Enter to confirm')
    expect(visual).toContain('Esc to cancel')

    const screenReader = frame(model, true, 80).replace(/\s+/gu, ' ')
    expect(screenReader).toContain('Selected: 1. No, stay put')
    expect(screenReader).toContain('read, edit, and execute files')
    expect(screenReader).toContain(
      'Security guide: https://code.claude.com/docs/en/security',
    )
    expect(screenReader).toContain('2. Yes, move here')
    expect(screenReader).toContain('Enter to confirm')
    expect(screenReader).toContain('Escape to cancel')
    expect(screenReader).not.toContain('❯')
  })

  it('renders complete plan screen-reader semantics', () => {
    const output = frame(plan(0), true)
    const semantic = output.replace(/\s+/g, ' ')
    expect(output).toContain('Ready to code?')
    expect(output).toContain('Do the work')
    expect(output).toContain('/tmp/plan.md')
    expect(output).toContain('Selected: 1. Yes, and use auto mode')
    for (const label of [
      'Enter selection [1-3]',
      'Tab to add feedback',
      'Use up/down arrows to change selection',
      'Press 1, 2, or 3 to choose directly',
      'Press y to approve',
      'Press n to keep planning',
      'Escape to cancel',
    ])
      expect(semantic).toContain(label)
    expect(output).not.toContain('❯')
    expect(output).not.toContain('─')
  })

  it('renders feedback actions and raw feedback without selection claims', () => {
    const output = frame(plan(2, true, 'change this'), true)
    expect(output).toContain('Feedback: change this')
    expect(output).toContain('change this')
    expect(output).toContain('Enter to submit')
    expect(output).toContain('Tab to collapse feedback')
    expect(output).toContain('Escape to cancel')
    expect(output).not.toContain('Enter selection')
  })

  it('renders question semantics, guidance, and cancellation once', () => {
    const single = projectTuiDecisionSurface({
      kind: 'question',
      questions: [
        {
          header: 'H',
          question: 'Q',
          multiSelect: false,
          options: [
            { label: 'One', description: 'D', preview: 'P' },
            { label: 'Two', description: 'D2' },
          ],
        },
      ],
      questionIndex: 0,
      answer: '',
    })
    const output = frame(single, true)
    expect(output).toContain('Question 1 of 1')
    for (const label of [
      '1. One — D',
      'P',
      '2. Two — D2',
      'Current answer: (empty)',
      'Enter one option number or custom text',
      'Escape cancels',
    ])
      expect(output).toContain(label)
    expect(output.match(/Escape cancels/g)?.length).toBe(1)
    expect(output).not.toContain('❯')
    expect(output).not.toContain('─')
    const multi = projectTuiDecisionSurface({
      kind: 'question',
      questions: [
        { header: 'H', question: 'Q', multiSelect: true, options: [] },
      ],
      questionIndex: 0,
      answer: '1, 2',
    })
    expect(frame(multi, true)).toContain(
      'Enter comma-separated option numbers or custom text',
    )
  })

  it('renders empty questions once and keeps visual controls at narrow width', () => {
    const empty = projectTuiDecisionSurface({
      kind: 'question',
      questions: [],
      questionIndex: 2,
      answer: '',
    })
    const emptyOutput = frame(empty, true)
    expect(emptyOutput.match(/No questions available\./g)?.length).toBe(1)
    expect(emptyOutput).not.toContain('Enter to submit')
    const visual = frame(plan(1), false, 20)
    const semanticVisual = visual
      .replace(/[╭╮╰╯│─]+/gu, ' ')
      .replace(/\s+/g, ' ')
    expect(semanticVisual).toContain('Ready to code?')
    expect(semanticVisual).toContain('❯ 2. Yes, manually approve edits')
    expect(semanticVisual).toContain(
      'Enter to confirm · Tab to add feedback · Esc to cancel',
    )
    expect(frame(plan(0), false, Number.NaN)).toContain('Do the work')

    const question = projectTuiDecisionSurface({
      kind: 'question',
      questions: [
        {
          header: 'Runtime',
          question: 'Which runtime?',
          multiSelect: false,
          options: [{ label: 'Node', description: 'Use Node.js' }],
        },
      ],
      questionIndex: 0,
      answer: '',
    })
    const visualQuestion = frame(question, false, 20)
      .replace(/[╭╮╰╯│─]+/gu, ' ')
      .replace(/\s+/g, ' ')
    expect(visualQuestion).toContain(
      'Enter one option number or custom text · Esc cancels',
    )
    expect(visualQuestion).not.toContain('Enter to submit')
    expect(visualQuestion.match(/Esc cancels/g)?.length).toBe(1)
  })
})
