import type {
  ClaudePlanApprovalRequest,
  ClaudeQuestion,
} from '../../tools/claude-interactive-tools.js'
import type { ClaudePermissionMode } from '../../permissions/claude-permission-resolver.js'

export type TuiPlanElevatedMode = Extract<
  ClaudePermissionMode,
  'auto' | 'bypassPermissions' | 'acceptEdits'
>

export interface TuiDecisionSurfaceAction {
  readonly visualLabel?: string
  readonly screenReaderLabel: string
}

export interface TuiDecisionSurfaceOption {
  readonly index: number
  readonly label: string
  readonly description?: string
  readonly preview?: string
  readonly selected: boolean
}

export interface TuiDecisionSurfaceCancellation {
  readonly visualLabel: string
  readonly screenReaderLabel: string
}

export interface TuiDecisionSurfaceRange {
  readonly min: number
  readonly max: number
}

export type TuiDecisionSurfaceInput =
  | {
      readonly kind: 'plan-approval'
      readonly request: ClaudePlanApprovalRequest
      readonly selectedIndex: number
      readonly feedbackMode: boolean
      readonly feedback: string
      readonly elevatedMode: TuiPlanElevatedMode
    }
  | {
      readonly kind: 'question'
      readonly questions: readonly ClaudeQuestion[]
      readonly questionIndex: number
      readonly answer: string
    }
  | {
      readonly kind: 'cd-trust'
      readonly canonicalPath: string
      readonly selectedIndex: number
    }

export interface TuiPlanApprovalSurfaceModel {
  readonly kind: 'plan-approval'
  readonly heading: 'Ready to code?'
  readonly intro: "Here is Praxis's plan:"
  readonly explanation: string
  readonly planPath: string
  readonly plan?: string
  readonly options: readonly TuiDecisionSurfaceOption[]
  readonly selectedIndex: number
  readonly range: TuiDecisionSurfaceRange
  readonly feedbackMode: boolean
  readonly feedback: string
  readonly feedbackPlaceholder: string
  readonly actions: readonly TuiDecisionSurfaceAction[]
  readonly cancellation: TuiDecisionSurfaceCancellation
}

export interface TuiQuestionSurfaceModel {
  readonly kind: 'question'
  readonly questionIndex: number
  readonly questionCount: number
  readonly progress: string
  readonly header: string
  readonly question: string
  readonly heading: string
  readonly multiSelect: boolean
  readonly answer: string
  readonly options: readonly TuiDecisionSurfaceOption[]
  readonly range: TuiDecisionSurfaceRange
  readonly guidance?: string
  readonly actions: readonly TuiDecisionSurfaceAction[]
  readonly cancellation: TuiDecisionSurfaceCancellation
  readonly emptyState?: string
}

export interface TuiCdTrustSurfaceModel {
  readonly kind: 'cd-trust'
  readonly heading: 'Moving to a new directory:'
  readonly canonicalPath: string
  readonly explanation: "This session hasn't worked here before. Is this a directory you created or one you trust?"
  readonly scope: 'Praxis can read, edit, and execute files in this directory.'
  readonly securityGuide: 'Security guide: https://code.claude.com/docs/en/security'
  readonly options: readonly TuiDecisionSurfaceOption[]
  readonly selectedIndex: number
  readonly range: TuiDecisionSurfaceRange
  readonly actions: readonly TuiDecisionSurfaceAction[]
  readonly cancellation: TuiDecisionSurfaceCancellation
}

export type TuiDecisionSurfaceModel =
  TuiPlanApprovalSurfaceModel | TuiQuestionSurfaceModel | TuiCdTrustSurfaceModel

function normalizeIndex(value: number, count: number, empty = -1): number {
  if (count === 0) return empty
  const integer = Number.isFinite(value) ? Math.trunc(value) : 0
  return Math.max(0, Math.min(count - 1, integer))
}

function range(count: number): TuiDecisionSurfaceRange {
  return { min: count > 0 ? 1 : 0, max: count }
}

const cancellation: TuiDecisionSurfaceCancellation = {
  visualLabel: 'Esc to cancel',
  screenReaderLabel: 'Escape to cancel',
}
const questionCancellation: TuiDecisionSurfaceCancellation = {
  visualLabel: 'Esc cancels',
  screenReaderLabel: 'Escape cancels',
}

function projectedOptions(
  options: readonly { label: string; description?: string; preview?: string }[],
  selectedIndex: number,
): readonly TuiDecisionSurfaceOption[] {
  return options.map((option, index) => ({
    index: index + 1,
    label: option.label,
    ...(option.description === undefined
      ? {}
      : { description: option.description }),
    ...(option.preview === undefined ? {} : { preview: option.preview }),
    selected: index === selectedIndex,
  }))
}

function emptyQuestionModel(answer: string): TuiQuestionSurfaceModel {
  return {
    kind: 'question',
    questionIndex: -1,
    questionCount: 0,
    progress: 'Question 0 of 0',
    header: '',
    question: '',
    heading: 'Question',
    multiSelect: false,
    answer,
    options: [],
    range: range(0),
    actions: [],
    cancellation: questionCancellation,
    emptyState: 'No questions available.',
  }
}

export function projectTuiDecisionSurface(
  input: TuiDecisionSurfaceInput,
): TuiDecisionSurfaceModel {
  if (input.kind === 'plan-approval') {
    const selectedIndex = normalizeIndex(input.selectedIndex, 3)
    const elevatedLabel =
      input.elevatedMode === 'auto'
        ? 'Yes, and use auto mode'
        : input.elevatedMode === 'bypassPermissions'
          ? 'Yes, and bypass permissions'
          : 'Yes, auto-accept edits'
    const options = projectedOptions(
      [
        { label: elevatedLabel },
        { label: 'Yes, manually approve edits' },
        { label: 'No, keep planning' },
      ],
      selectedIndex,
    )
    return {
      kind: 'plan-approval',
      heading: 'Ready to code?',
      intro: "Here is Praxis's plan:",
      explanation:
        'Praxis has written up a plan and is ready to execute. Would you like to proceed?',
      planPath: input.request.planPath,
      ...(input.request.plan ? { plan: input.request.plan } : {}),
      options,
      selectedIndex,
      range: range(options.length),
      feedbackMode: input.feedbackMode,
      feedback: input.feedback,
      feedbackPlaceholder:
        selectedIndex === 2
          ? 'Tell Praxis what to change'
          : 'Add feedback for implementation',
      actions: input.feedbackMode
        ? [
            {
              visualLabel: 'Enter to submit',
              screenReaderLabel: 'Enter to submit',
            },
            {
              visualLabel: 'Tab to collapse',
              screenReaderLabel: 'Tab to collapse feedback',
            },
          ]
        : [
            {
              visualLabel: 'Enter to confirm',
              screenReaderLabel: 'Enter selection [1-3]',
            },
            {
              visualLabel: 'Tab to add feedback',
              screenReaderLabel: 'Tab to add feedback',
            },
            { screenReaderLabel: 'Use up/down arrows to change selection' },
            { screenReaderLabel: 'Press 1, 2, or 3 to choose directly' },
            { screenReaderLabel: 'Press y to approve' },
            { screenReaderLabel: 'Press n to keep planning' },
          ],
      cancellation,
    }
  }

  if (input.kind === 'cd-trust') {
    const selectedIndex = normalizeIndex(input.selectedIndex, 2)
    const options = projectedOptions(
      [{ label: 'No, stay put' }, { label: 'Yes, move here' }],
      selectedIndex,
    )
    return {
      kind: 'cd-trust',
      heading: 'Moving to a new directory:',
      canonicalPath: input.canonicalPath,
      explanation:
        "This session hasn't worked here before. Is this a directory you created or one you trust?",
      scope: 'Praxis can read, edit, and execute files in this directory.',
      securityGuide: 'Security guide: https://code.claude.com/docs/en/security',
      options,
      selectedIndex,
      range: range(options.length),
      actions: [
        {
          visualLabel: 'Enter to confirm',
          screenReaderLabel: 'Enter to confirm',
        },
        { screenReaderLabel: 'Use up and down arrows to change selection' },
        { screenReaderLabel: 'Press 1 or 2 to choose directly' },
        { screenReaderLabel: 'Press y to move here' },
        { screenReaderLabel: 'Press n to stay put' },
      ],
      cancellation,
    }
  }

  const count = input.questions.length
  const questionIndex = normalizeIndex(input.questionIndex, count)
  if (count === 0) return emptyQuestionModel(input.answer)
  const current = input.questions[questionIndex]
  if (current === undefined) return emptyQuestionModel(input.answer)
  const options = projectedOptions(current.options, -1)
  const guidance = current.multiSelect
    ? 'Enter comma-separated option numbers or custom text'
    : 'Enter one option number or custom text'
  return {
    kind: 'question',
    questionIndex,
    questionCount: count,
    progress: `Question ${questionIndex + 1} of ${count}`,
    header: current.header,
    question: current.question,
    heading: `${current.header}: ${current.question}`,
    multiSelect: current.multiSelect,
    answer: input.answer,
    options,
    range: range(options.length),
    guidance,
    actions: [{ visualLabel: guidance, screenReaderLabel: guidance }],
    cancellation: questionCancellation,
  }
}
