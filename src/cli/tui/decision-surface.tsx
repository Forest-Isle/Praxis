import { Box, Text } from 'ink'

import { DialogFrame } from './claude-style.js'
import type {
  TuiDecisionSurfaceModel,
  TuiQuestionSurfaceModel,
  TuiPlanApprovalSurfaceModel,
  TuiCdTrustSurfaceModel,
} from './decision-surface-model.js'
import { useTuiTheme } from './theme.js'

function Footer({
  actions,
  cancellation,
  screenReader,
}: Pick<TuiDecisionSurfaceModel, 'actions' | 'cancellation'> & {
  screenReader: boolean
}) {
  const labels = actions.flatMap((action) =>
    screenReader
      ? [action.screenReaderLabel]
      : action.visualLabel === undefined
        ? []
        : [action.visualLabel],
  )
  return (
    <Text dimColor>
      {labels
        .concat(
          screenReader
            ? cancellation.screenReaderLabel
            : cancellation.visualLabel,
        )
        .join(' · ')}
    </Text>
  )
}

function Option({
  option,
  screenReader,
}: {
  option: TuiPlanApprovalSurfaceModel['options'][number]
  screenReader: boolean
}) {
  const theme = useTuiTheme()
  const selected = option.selected
  return (
    <Text {...(selected ? theme.text.selectedRow : {})}>
      {screenReader || theme.noColor
        ? selected
          ? 'Selected: '
          : ''
        : selected
          ? '❯ '
          : '  '}
      {option.index}. {option.label}
      {option.description ? `: ${option.description}` : ''}
    </Text>
  )
}

function PlanSurface({
  model,
  screenReader,
}: {
  model: TuiPlanApprovalSurfaceModel
  screenReader: boolean
}) {
  return (
    <DialogFrame title={model.heading} screenReader={screenReader}>
      <Text>{model.intro}</Text>
      {model.plan ? (
        <Box
          borderStyle={screenReader ? undefined : 'classic'}
          borderLeft={false}
          borderRight={false}
          paddingX={screenReader ? 0 : 1}
          marginY={1}
        >
          <Text>{model.plan}</Text>
        </Box>
      ) : null}
      <Text dimColor>{model.explanation}</Text>
      {model.options.map((option) => (
        <Option
          key={option.index}
          option={option}
          screenReader={screenReader}
        />
      ))}
      {model.feedbackMode ? (
        <Text>
          {screenReader ? 'Feedback: ' : '› '}
          {model.feedback || model.feedbackPlaceholder}
        </Text>
      ) : null}
      <Text dimColor>{model.planPath}</Text>
      <Footer {...model} screenReader={screenReader} />
    </DialogFrame>
  )
}

function QuestionSurface({
  model,
  screenReader,
}: {
  model: TuiQuestionSurfaceModel
  screenReader: boolean
}) {
  return (
    <DialogFrame title={model.heading} screenReader={screenReader}>
      <Text>{model.progress}</Text>
      {model.emptyState ? <Text dimColor>{model.emptyState}</Text> : null}
      {model.options.map((option) => (
        <Box key={`${option.index}-${option.label}`} flexDirection="column">
          <Text>
            {option.index}. {option.label}
            {option.description ? ` — ${option.description}` : ''}
          </Text>
          {option.preview ? <Text dimColor>{option.preview}</Text> : null}
        </Box>
      ))}
      <Text>
        {screenReader ? 'Current answer: ' : '› '}
        {model.answer || (screenReader ? '(empty)' : '')}
      </Text>
      <Footer {...model} screenReader={screenReader} />
    </DialogFrame>
  )
}

function CdTrustSurface({
  model,
  screenReader,
}: {
  model: TuiCdTrustSurfaceModel
  screenReader: boolean
}) {
  return (
    <DialogFrame title={model.heading} screenReader={screenReader}>
      <Text>{model.canonicalPath}</Text>
      <Text dimColor>{model.explanation}</Text>
      <Text dimColor>{model.scope}</Text>
      <Text dimColor>{model.securityGuide}</Text>
      {model.options.map((option) => (
        <Option
          key={option.index}
          option={option}
          screenReader={screenReader}
        />
      ))}
      <Footer {...model} screenReader={screenReader} />
    </DialogFrame>
  )
}

export function DecisionSurface({
  model,
  width,
  screenReader,
}: {
  model: TuiDecisionSurfaceModel
  width: number
  screenReader: boolean
}) {
  const content =
    model.kind === 'plan-approval' ? (
      <PlanSurface model={model} screenReader={screenReader} />
    ) : model.kind === 'question' ? (
      <QuestionSurface model={model} screenReader={screenReader} />
    ) : (
      <CdTrustSurface model={model} screenReader={screenReader} />
    )
  const normalizedWidth = Number.isFinite(width)
    ? Math.min(100, Math.max(1, Math.trunc(width)))
    : 100
  return screenReader ? content : <Box width={normalizedWidth}>{content}</Box>
}
