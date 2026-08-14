import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, relative } from 'node:path'

import { Box, Text } from 'ink'

import type { ModelToolCall } from '../../core/runtime.js'
import { redactSensitiveText } from '../../platform/sensitive-data.js'

export type TuiToolPermissionAction =
  | 'allow-once'
  | 'allow-session-edits'
  | 'allow-session-action'
  | 'persist-rule'
  | 'deny'

export interface TuiToolPermissionOption {
  action: TuiToolPermissionAction
  label: string
  rule?: string
}

export interface TuiToolPermissionModel {
  kind:
    | 'bash'
    | 'file'
    | 'notebook'
    | 'filesystem'
    | 'web-fetch'
    | 'skill'
    | 'generic'
  title: string
  subtitle?: string
  description?: string
  question: string
  detail: readonly { prefix?: '+' | '-'; text: string }[]
  options: readonly TuiToolPermissionOption[]
}

function stringInput(call: ModelToolCall, name: string): string | undefined {
  const value = call.input[name]
  return typeof value === 'string' ? value : undefined
}

function redact(value: string, sensitiveValues: readonly string[]): string {
  return redactSensitiveText(value, sensitiveValues)
}

function visibleLines(value: string, limit = 20): readonly string[] {
  const lines = value.split('\n')
  if (lines.length <= limit) return lines
  return [...lines.slice(0, limit), `… ${lines.length - limit} more lines`]
}

function ruleForExactCommand(command: string): string {
  return `Bash(${command})`
}

function fileSessionLabel(
  path: string,
  cwd: string,
  readOnly: boolean,
): string {
  const pathRelativeToCwd = relative(cwd, path)
  if (!pathRelativeToCwd.startsWith('..')) {
    return readOnly
      ? 'Yes, during this session'
      : 'Yes, allow all edits during this session (shift+tab)'
  }
  const directory = basename(dirname(path)) || 'this directory'
  return readOnly
    ? `Yes, allow reading from ${directory}/ during this session`
    : `Yes, allow all edits in ${directory}/ during this session (shift+tab)`
}

function fileOptions(
  call: ModelToolCall,
  path: string,
  cwd: string,
  readOnly: boolean,
): readonly TuiToolPermissionOption[] {
  return [
    { action: 'allow-once', label: 'Yes' },
    {
      action: readOnly ? 'allow-session-action' : 'allow-session-edits',
      label: fileSessionLabel(path, cwd, readOnly),
      ...(readOnly ? { rule: `${call.name}(${path})` } : {}),
    },
    { action: 'deny', label: 'No' },
  ]
}

function fileModel(
  call: ModelToolCall,
  cwd: string,
  sensitiveValues: readonly string[],
): TuiToolPermissionModel | undefined {
  const path = stringInput(call, 'file_path')
  if (!path) return undefined
  const displayPath = redact(path, sensitiveValues)
  const displayRelativePath = redact(relative(cwd, path), sensitiveValues)
  if (call.name === 'Edit') {
    const oldString = redact(
      stringInput(call, 'old_string') ?? '',
      sensitiveValues,
    )
    const newString = redact(
      stringInput(call, 'new_string') ?? '',
      sensitiveValues,
    )
    return {
      kind: 'file',
      title: 'Edit file',
      subtitle: displayRelativePath,
      question: `Do you want to make this edit to ${basename(displayPath)}?`,
      detail: [
        ...visibleLines(oldString).map((text) => ({
          prefix: '-' as const,
          text,
        })),
        ...visibleLines(newString).map((text) => ({
          prefix: '+' as const,
          text,
        })),
      ],
      options: fileOptions(call, path, cwd, false),
    }
  }
  if (call.name === 'Write') {
    const fileExists = existsSync(path)
    const content = redact(stringInput(call, 'content') ?? '', sensitiveValues)
    let oldContent = ''
    if (fileExists) {
      try {
        oldContent = redact(readFileSync(path, 'utf8'), sensitiveValues)
      } catch {
        oldContent = ''
      }
    }
    return {
      kind: 'file',
      title: fileExists ? 'Overwrite file' : 'Create file',
      subtitle: displayRelativePath,
      question: `Do you want to ${fileExists ? 'overwrite' : 'create'} ${basename(displayPath)}?`,
      detail: [
        ...(fileExists
          ? visibleLines(oldContent).map((text) => ({
              prefix: '-' as const,
              text,
            }))
          : []),
        ...visibleLines(content).map((text) => ({
          prefix: '+' as const,
          text,
        })),
      ],
      options: fileOptions(call, path, cwd, false),
    }
  }
  return undefined
}

function notebookModel(
  call: ModelToolCall,
  cwd: string,
  sensitiveValues: readonly string[],
): TuiToolPermissionModel | undefined {
  if (call.name !== 'NotebookEdit') return undefined
  const path = stringInput(call, 'notebook_path')
  if (!path) return undefined
  const mode = stringInput(call, 'edit_mode') ?? 'replace'
  const action =
    mode === 'insert'
      ? 'insert this cell into'
      : mode === 'delete'
        ? 'delete this cell from'
        : 'make this edit to'
  const source = redact(stringInput(call, 'new_source') ?? '', sensitiveValues)
  return {
    kind: 'notebook',
    title: 'Edit notebook',
    subtitle: redact(relative(cwd, path), sensitiveValues),
    question: `Do you want to ${action} ${basename(path)}?`,
    detail: visibleLines(source).map((text) => ({
      prefix: mode === 'delete' ? '-' : '+',
      text,
    })),
    options: fileOptions(call, path, cwd, false),
  }
}

function filesystemModel(
  call: ModelToolCall,
  cwd: string,
  sensitiveValues: readonly string[],
): TuiToolPermissionModel | undefined {
  if (!['Read', 'Glob', 'Grep'].includes(call.name)) return undefined
  const path =
    stringInput(call, 'file_path') ?? stringInput(call, 'path') ?? cwd
  const display = redact(path, sensitiveValues)
  const argument =
    call.name === 'Glob'
      ? (stringInput(call, 'pattern') ?? '')
      : call.name === 'Grep'
        ? (stringInput(call, 'pattern') ?? '')
        : display
  return {
    kind: 'filesystem',
    title: 'Read file',
    question: 'Do you want to proceed?',
    detail: [{ text: `${call.name}(${redact(argument, sensitiveValues)})` }],
    options: fileOptions(call, path, cwd, true),
  }
}

function webFetchModel(
  call: ModelToolCall,
  sensitiveValues: readonly string[],
): TuiToolPermissionModel | undefined {
  if (call.name !== 'WebFetch') return undefined
  const rawUrl = stringInput(call, 'url') ?? ''
  let hostname = rawUrl
  try {
    hostname = new URL(rawUrl).hostname
  } catch {
    // The runtime will report malformed tool input after permission handling.
  }
  const prompt = stringInput(call, 'prompt')
  const description = stringInput(call, 'description')
  return {
    kind: 'web-fetch',
    title: 'Fetch',
    ...(description ? { description } : {}),
    question: 'Do you want to allow Claude to fetch this content?',
    detail: [
      { text: redact(rawUrl, sensitiveValues) },
      ...(prompt ? [{ text: redact(prompt, sensitiveValues) }] : []),
    ],
    options: [
      { action: 'allow-once', label: 'Yes' },
      {
        action: 'persist-rule',
        label: `Yes, and don't ask again for ${hostname}`,
        rule: `WebFetch(domain:${hostname})`,
      },
      { action: 'deny', label: 'No, and tell Claude what to do differently' },
    ],
  }
}

function bashModel(
  call: ModelToolCall,
  cwd: string,
  sensitiveValues: readonly string[],
): TuiToolPermissionModel | undefined {
  if (call.name !== 'Bash' && call.name !== 'PowerShell') return undefined
  const command = stringInput(call, 'command') ?? ''
  const description = stringInput(call, 'description')
  const displayCommand = redact(command, sensitiveValues)
  const rule =
    call.name === 'Bash'
      ? ruleForExactCommand(command)
      : `${call.name}(${command})`
  return {
    kind: 'bash',
    title: call.name === 'Bash' ? 'Bash command' : 'PowerShell command',
    ...(description
      ? { description: redact(description, sensitiveValues) }
      : {}),
    question: 'Do you want to proceed?',
    detail: visibleLines(displayCommand).map((text) => ({ text })),
    options: [
      { action: 'allow-once', label: 'Yes' },
      {
        action: 'persist-rule',
        label: `Yes, and don't ask again for ${displayCommand || call.name} in ${cwd}`,
        rule,
      },
      { action: 'deny', label: 'No' },
    ],
  }
}

export function projectTuiToolPermission(
  call: ModelToolCall,
  cwd: string,
  sensitiveValues: readonly string[],
): TuiToolPermissionModel {
  const specialized =
    bashModel(call, cwd, sensitiveValues) ??
    fileModel(call, cwd, sensitiveValues) ??
    notebookModel(call, cwd, sensitiveValues) ??
    filesystemModel(call, cwd, sensitiveValues) ??
    webFetchModel(call, sensitiveValues)
  if (specialized) return specialized

  const skill = stringInput(call, 'skill') ?? stringInput(call, 'name')
  if (call.name === 'Skill' && skill) {
    return {
      kind: 'skill',
      title: `Use Skill: ${redact(skill, sensitiveValues)}`,
      question: 'Claude may use instructions, code, or files from this Skill.',
      detail: [],
      options: [
        { action: 'allow-once', label: 'Yes' },
        {
          action: 'persist-rule',
          label: `Yes, and don't ask again for ${skill} in ${cwd}`,
          rule: `Skill(${skill})`,
        },
        { action: 'deny', label: 'No' },
      ],
    }
  }

  const serialized = redact(JSON.stringify(call.input), sensitiveValues)
  return {
    kind: 'generic',
    title: 'Tool use',
    question: 'Do you want to proceed?',
    detail: [{ text: `${redact(call.name, sensitiveValues)}(${serialized})` }],
    options: [
      { action: 'allow-once', label: 'Yes' },
      {
        action: 'persist-rule',
        label: `Yes, and don't ask again for ${call.name} commands in ${cwd}`,
        rule: call.name,
      },
      { action: 'deny', label: 'No' },
    ],
  }
}

export function ToolPermissionDialog({
  model,
  selection,
  feedbackMode,
  feedback,
  screenReader,
}: {
  model: TuiToolPermissionModel
  selection: number
  feedbackMode: boolean
  feedback: string
  screenReader: boolean
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle={screenReader ? undefined : 'round'}
      borderColor="yellow"
      paddingX={screenReader ? 0 : 1}
      marginTop={1}
    >
      <Text bold>{model.title}</Text>
      {model.subtitle ? <Text dimColor>{model.subtitle}</Text> : null}
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {model.detail.map((line, index) => {
          const content = `${line.prefix ? `${line.prefix} ` : ''}${line.text}`
          return line.prefix ? (
            <Text
              key={`${index}-${line.prefix}`}
              color={line.prefix === '+' ? 'green' : 'red'}
            >
              {content}
            </Text>
          ) : (
            <Text key={`${index}-`}>{content}</Text>
          )
        })}
        {model.description ? <Text dimColor>{model.description}</Text> : null}
      </Box>
      <Text>{model.question}</Text>
      {model.options.map((option, index) => (
        <Text key={`${option.action}-${index}`} bold={selection === index}>
          {selection === index ? (screenReader ? 'Selected: ' : '❯ ') : '  '}
          {index + 1}. {option.label}
        </Text>
      ))}
      {feedbackMode ? (
        <Text>
          ›{' '}
          {feedback ||
            (model.options[selection]?.action === 'deny'
              ? 'tell Praxis what to do differently'
              : 'tell Praxis what to do next')}
        </Text>
      ) : null}
      <Text dimColor>
        {feedbackMode
          ? 'Enter to submit · Tab to collapse · Esc to cancel'
          : 'Esc to cancel · Tab to amend'}
      </Text>
    </Box>
  )
}
