import { Box, Text } from 'ink'

import { DialogFrame } from './claude-style.js'
import { ToolPermissionDialog } from './tool-permission.js'
import type {
  TuiPermissionDashboardModel,
  TuiPermissionSurfaceModel,
  TuiPermissionSurfaceOption,
  TuiPermissionSurfaceRow,
} from './permission-surface-model.js'
import { useTuiTheme } from './theme.js'

function selectionPrefix(selected: boolean, screenReader: boolean): string {
  if (screenReader) return selected ? 'Selected: ' : ''
  return selected ? '❯ ' : '  '
}

function optionsBlock(
  options: readonly TuiPermissionSurfaceOption[],
  screenReader: boolean,
  selectedRow: ReturnType<typeof useTuiTheme>['text']['selectedRow'],
): React.ReactNode {
  return options.map((option) => (
    <Text
      key={`${option.index}-${option.label}`}
      {...(option.selected ? selectedRow : {})}
    >
      {selectionPrefix(option.selected, screenReader)}
      {option.index}. {option.label}
      {option.description ? `: ${option.description}` : ''}
    </Text>
  ))
}

function rowsBlock(
  rows: readonly TuiPermissionSurfaceRow[],
  screenReader: boolean,
  selectedRow: ReturnType<typeof useTuiTheme>['text']['selectedRow'],
): React.ReactNode {
  return rows.map((row) => (
    <Text
      key={`${row.index}-${row.id ?? row.label}`}
      {...(row.selected ? selectedRow : {})}
    >
      {selectionPrefix(row.selected, screenReader)}
      {row.index}.{' '}
      {row.status === 'retrying'
        ? screenReader
          ? 'Retrying: '
          : '✔ '
        : row.status === 'denied'
          ? screenReader
            ? 'Denied: '
            : '✘ '
          : ''}
      {row.label}
      {row.status === 'retrying' ? ' (retry)' : ''}
      {row.description ? `  ${row.description}` : ''}
    </Text>
  ))
}

function Footer({
  model,
  screenReader,
}: {
  model: TuiPermissionSurfaceModel
  screenReader: boolean
}) {
  const enter =
    'range' in model && model.range.max > 0
      ? `Enter selection [1-${model.range.max}]`
      : (model.actions[0]?.label ?? 'Enter')
  const completeActions = model.actions.map((action) =>
    screenReader
      ? action.usesSelectionRange === true &&
        'range' in model &&
        model.range.max > 0
        ? enter
        : (action.screenReaderLabel ?? action.label)
      : action.label,
  )
  return (
    <Text dimColor>
      {screenReader
        ? `${completeActions.join(' · ')} · ${model.cancellation}`
        : `${completeActions.join(' · ')} · ${model.cancellation.replace('Escape', 'Esc')}`}
    </Text>
  )
}

function Dashboard({
  model,
  width,
  screenReader,
}: {
  model: TuiPermissionDashboardModel
  width: number
  screenReader: boolean
}) {
  const theme = useTuiTheme()
  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      {!screenReader ? (
        <Text dimColor>{'─'.repeat(Math.min(100, width))}</Text>
      ) : null}
      <Text {...theme.text.navigation} bold>
        {model.heading}
      </Text>
      <Text>
        {model.tabs.map((tab) => (
          <Text
            key={tab.label}
            {...(tab.current ? theme.text.selectedTab : {})}
          >
            {screenReader && tab.current ? 'Current tab: ' : ''}
            {tab.label}{' '}
          </Text>
        ))}
      </Text>
      <Text> </Text>
      <Text>{model.description}</Text>
      {model.emptyState ? <Text dimColor>{model.emptyState}</Text> : null}
      {model.tabIndex >= 1 && model.tabIndex <= 3 ? (
        <Box
          borderStyle={screenReader ? undefined : 'round'}
          paddingX={1}
          marginY={1}
        >
          <Text {...(model.query ? {} : { dimColor: true })}>
            {screenReader ? 'Search: ' : '⌕ '}
            {model.query || 'Search…'}
          </Text>
        </Box>
      ) : (
        <Text> </Text>
      )}
      {model.originalWorkspace ? (
        <Text>
          {screenReader ? '' : '    -  '}
          {model.originalWorkspace.label} ({model.originalWorkspace.description}
          )
        </Text>
      ) : null}
      {rowsBlock(model.rows, screenReader, theme.text.selectedRow)}
      <Text> </Text>
      <Footer model={model} screenReader={screenReader} />
    </Box>
  )
}

function InputSurface({
  heading,
  description,
  value,
  placeholder,
  model,
  screenReader,
}: {
  heading: string
  description: string
  value: string
  placeholder: string
  model: TuiPermissionSurfaceModel
  screenReader: boolean
}) {
  return (
    <Box flexDirection="column">
      <Text bold>{heading}</Text>
      {description.split('\n').map((line, index) => (
        <Text key={`${index}-${line}`}>{line || ' '}</Text>
      ))}
      <Box
        borderStyle={screenReader ? undefined : 'round'}
        paddingX={screenReader ? 0 : 1}
      >
        <Text {...(value ? {} : { dimColor: true })}>
          {value || placeholder}
        </Text>
      </Box>
      <Footer model={model} screenReader={screenReader} />
    </Box>
  )
}

export function PermissionSurface({
  model,
  width,
  screenReader,
}: {
  model: TuiPermissionSurfaceModel
  width: number
  screenReader: boolean
}) {
  const theme = useTuiTheme()
  switch (model.kind) {
    case 'tool-request':
      return (
        <Box flexDirection="column" width={Math.min(100, width)}>
          <ToolPermissionDialog
            model={model.tool}
            selection={model.selectedIndex}
            feedbackMode={model.feedbackMode}
            feedback={model.feedback}
            {...(model.ruleEditor === undefined
              ? {}
              : { ruleEditor: model.ruleEditor })}
            screenReader={screenReader}
          />
        </Box>
      )
    case 'recovery-request':
      return (
        <DialogFrame title={model.heading} screenReader={screenReader}>
          <Box
            flexDirection="column"
            paddingX={screenReader ? 0 : 1}
            paddingY={screenReader ? 0 : 1}
          >
            <Text bold>{model.display}</Text>
          </Box>
          <Text>{model.question}</Text>
          {optionsBlock(model.options, screenReader, theme.text.selectedRow)}
          {model.feedbackMode ? (
            <Text>
              {screenReader ? 'Feedback: ' : '› '}
              {model.feedback || model.feedbackPlaceholder}
            </Text>
          ) : null}
          <Footer model={model} screenReader={screenReader} />
        </DialogFrame>
      )
    case 'permission-dashboard':
      return (
        <Dashboard model={model} width={width} screenReader={screenReader} />
      )
    case 'permission-rule-input':
    case 'workspace-directory-input':
      return (
        <InputSurface
          heading={model.heading}
          description={model.description}
          value={model.value}
          placeholder={model.placeholder}
          model={model}
          screenReader={screenReader}
        />
      )
    case 'permission-scope':
      return (
        <Box flexDirection="column">
          <Text bold>{model.heading}</Text>
          <Text dimColor>{model.description}</Text>
          {optionsBlock(model.options, screenReader, theme.text.selectedRow)}
          <Footer model={model} screenReader={screenReader} />
        </Box>
      )
    case 'permission-delete':
      return (
        <Box
          flexDirection="column"
          borderStyle={screenReader ? undefined : 'round'}
          {...theme.surface.decision}
          paddingX={screenReader ? 0 : 1}
          marginTop={1}
        >
          <Text {...theme.text.heading} {...theme.text.warning} bold>
            {model.heading}
          </Text>
          <Text>{model.rule}</Text>
          {model.description ? <Text dimColor>{model.description}</Text> : null}
          <Text dimColor>{model.scope}</Text>
          <Text>{model.question}</Text>
          {optionsBlock(model.options, screenReader, theme.text.selectedRow)}
          <Footer model={model} screenReader={screenReader} />
        </Box>
      )
    case 'workspace-directory-delete':
      return (
        <Box flexDirection="column">
          <Text bold>{model.heading}</Text>
          <Text>{model.path}</Text>
          <Text>{model.description}</Text>
          {optionsBlock(model.options, screenReader, theme.text.selectedRow)}
          <Footer model={model} screenReader={screenReader} />
        </Box>
      )
  }
}
