import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

import { Box, Text } from 'ink'

import type {
  ModelToolCall,
  PermissionDecision,
  PermissionUpdate,
} from '../../core/runtime.js'
import { claudeBashPermissionRuleContent } from '../../permissions/claude-shell-permission.js'
import {
  extractPermissionRules,
  permissionRuleValueToString,
  shellPermissionSuggestions,
} from '../../permissions/permission-updates.js'
import { redactSensitiveText } from '../../platform/sensitive-data.js'
import {
  composerEditorSegments,
  type ComposerEditorState,
} from './composer-editor.js'
import { useTuiPalette } from './theme.js'

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
  updates?: readonly PermissionUpdate[]
  editableRule?: { toolName: string; initialValue: string }
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
  explanation?: string
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

function pathIsWithin(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path))
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function claudeFolderSessionOption(
  path: string,
  cwd: string,
): TuiToolPermissionOption | undefined {
  const projectClaude = resolve(cwd, '.claude')
  const globalClaude = resolve(homedir(), '.claude')
  const pattern = pathIsWithin(globalClaude, path)
    ? '~/.claude/**'
    : pathIsWithin(projectClaude, path)
      ? '/.claude/**'
      : undefined
  if (!pattern) return undefined
  return {
    action: 'allow-session-action',
    label: 'Yes, and allow Claude to edit its own settings for this session',
    rule: `Edit(${pattern})`,
    updates: [
      {
        type: 'addRules',
        rules: [{ toolName: 'Edit', ruleContent: pattern }],
        behavior: 'allow',
        destination: 'session',
      },
    ],
  }
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

function readSessionRule(path: string, cwd: string): string {
  const absolutePath = resolve(cwd, path)
  const target = pathIsWithin(cwd, absolutePath)
    ? absolutePath
    : `${dirname(absolutePath)}/**`
  return `Read(/${target})`
}

function fileOptions(
  path: string,
  cwd: string,
  readOnly: boolean,
  suggestions: readonly PermissionUpdate[] = [],
): readonly TuiToolPermissionOption[] {
  const claudeFolderOption = readOnly
    ? undefined
    : claudeFolderSessionOption(path, cwd)
  return [
    { action: 'allow-once', label: 'Yes' },
    claudeFolderOption ?? {
      action: readOnly ? 'allow-session-action' : 'allow-session-edits',
      label: fileSessionLabel(path, cwd, readOnly),
      ...(readOnly ? { rule: readSessionRule(path, cwd) } : {}),
      ...(suggestions.length ? { updates: suggestions } : {}),
    },
    { action: 'deny', label: 'No' },
  ]
}

function fileModel(
  call: ModelToolCall,
  cwd: string,
  sensitiveValues: readonly string[],
  decision?: PermissionDecision,
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
      options: fileOptions(
        path,
        cwd,
        false,
        decision?.behavior === 'ask' ? decision.suggestions : [],
      ),
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
      options: fileOptions(
        path,
        cwd,
        false,
        decision?.behavior === 'ask' ? decision.suggestions : [],
      ),
    }
  }
  return undefined
}

function notebookModel(
  call: ModelToolCall,
  cwd: string,
  sensitiveValues: readonly string[],
  decision?: PermissionDecision,
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
    options: fileOptions(
      path,
      cwd,
      false,
      decision?.behavior === 'ask' ? decision.suggestions : [],
    ),
  }
}

function filesystemModel(
  call: ModelToolCall,
  cwd: string,
  sensitiveValues: readonly string[],
  decision?: PermissionDecision,
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
    options: fileOptions(
      path,
      cwd,
      true,
      decision?.behavior === 'ask' ? decision.suggestions : [],
    ),
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
  sensitiveValues: readonly string[],
  decision?: PermissionDecision,
): TuiToolPermissionModel | undefined {
  if (call.name !== 'Bash' && call.name !== 'PowerShell') return undefined
  const command = stringInput(call, 'command') ?? ''
  const description = stringInput(call, 'description')
  const displayCommand = redact(command, sensitiveValues)
  const fallbackRuleContent =
    call.name === 'Bash' ? claudeBashPermissionRuleContent(command) : command
  const suggestions =
    decision?.behavior === 'ask' && decision.suggestions?.length
      ? decision.suggestions
      : shellPermissionSuggestions(call.name, command)
  const suggestedRules = extractPermissionRules(suggestions)
  const shellRules = suggestedRules.filter(
    (rule) => rule.toolName === call.name,
  )
  const hasNonShellSuggestions = suggestions.some(
    (update) =>
      update.type === 'addDirectories' ||
      (update.type === 'addRules' &&
        update.rules.some((rule) => rule.toolName !== call.name)),
  )
  const editableRuleContent =
    !hasNonShellSuggestions && shellRules.length === 1
      ? shellRules[0]?.ruleContent
      : undefined
  const ruleContent = editableRuleContent ?? fallbackRuleContent
  const rule = `${call.name}(${ruleContent})`
  const persistentOption: TuiToolPermissionOption | undefined =
    call.name === 'PowerShell' && command.includes('\n')
      ? undefined
      : {
          action: 'persist-rule',
          label:
            shellRules.length > 1
              ? `Yes, and don’t ask again for ${shellRules
                  .map(permissionRuleValueToString)
                  .join(', ')}`
              : 'Yes, and don’t ask again for',
          ...(shellRules.length === 1 ? { rule } : {}),
          updates: suggestions,
          ...(editableRuleContent === undefined
            ? {}
            : {
                editableRule: {
                  toolName: call.name,
                  initialValue: editableRuleContent,
                },
              }),
        }
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
      ...(persistentOption ? [persistentOption] : []),
      { action: 'deny', label: 'No' },
    ],
  }
}

export function projectTuiToolPermission(
  call: ModelToolCall,
  cwd: string,
  sensitiveValues: readonly string[],
  decision?: PermissionDecision,
): TuiToolPermissionModel {
  const explain = (model: TuiToolPermissionModel): TuiToolPermissionModel =>
    decision?.behavior === 'ask' && decision.reason
      ? {
          ...model,
          explanation: redact(decision.reason, sensitiveValues),
        }
      : model
  const specialized =
    bashModel(call, sensitiveValues, decision) ??
    fileModel(call, cwd, sensitiveValues, decision) ??
    notebookModel(call, cwd, sensitiveValues, decision) ??
    filesystemModel(call, cwd, sensitiveValues, decision) ??
    webFetchModel(call, sensitiveValues)
  if (specialized) return explain(specialized)

  const skill = stringInput(call, 'skill') ?? stringInput(call, 'name')
  if (call.name === 'Skill' && skill) {
    const suggestions =
      decision?.behavior === 'ask' ? (decision.suggestions ?? []) : []
    const suggestedOptions = suggestions.flatMap((update) => {
      if (update.type !== 'addRules') return []
      return update.rules.flatMap((value) => {
        if (value.toolName !== 'Skill') return []
        const rule = permissionRuleValueToString(value)
        const prefix = value.ruleContent?.endsWith(':*') === true
        return [
          {
            action: 'persist-rule' as const,
            label: prefix
              ? `Yes, and don't ask again for ${value.ruleContent} commands in ${cwd}`
              : `Yes, and don't ask again for ${skill} in ${cwd}`,
            rule,
            updates: [
              {
                ...update,
                rules: [value],
              },
            ],
          },
        ]
      })
    })
    return explain({
      kind: 'skill',
      title: `Use skill "${redact(skill, sensitiveValues)}"?`,
      question: 'Claude may use instructions, code, or files from this Skill.',
      detail: [],
      options: [
        { action: 'allow-once', label: 'Yes' },
        ...(suggestedOptions.length
          ? suggestedOptions
          : [
              {
                action: 'persist-rule' as const,
                label: `Yes, and don't ask again for ${skill} in ${cwd}`,
                rule: `Skill(${skill})`,
              },
              ...(skill.includes(' ')
                ? [
                    {
                      action: 'persist-rule' as const,
                      label: `Yes, and don't ask again for ${skill.split(' ', 1)[0]}:* commands in ${cwd}`,
                      rule: `Skill(${skill.split(' ', 1)[0]}:*)`,
                    },
                  ]
                : []),
            ]),
        { action: 'deny', label: 'No' },
      ],
    })
  }

  const serialized = redact(JSON.stringify(call.input), sensitiveValues)
  return explain({
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
  })
}

export function ToolPermissionDialog({
  model,
  selection,
  feedbackMode,
  feedback,
  ruleEditor,
  screenReader,
}: {
  model: TuiToolPermissionModel
  selection: number
  feedbackMode: boolean
  feedback: string
  ruleEditor?: ComposerEditorState | null
  screenReader: boolean
}) {
  const palette = useTuiPalette()
  return (
    <Box
      flexDirection="column"
      borderStyle={screenReader ? undefined : 'round'}
      borderColor={palette.warning}
      paddingX={screenReader ? 0 : 1}
      marginTop={1}
    >
      <Text bold color={palette.warning}>
        {model.title}
      </Text>
      {model.subtitle ? <Text dimColor>{model.subtitle}</Text> : null}
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {model.detail.map((line, index) => {
          const content = `${line.prefix ? `${line.prefix} ` : ''}${line.text}`
          return line.prefix ? (
            <Text
              key={`${index}-${line.prefix}`}
              color={line.prefix === '+' ? palette.success : palette.error}
            >
              {content}
            </Text>
          ) : (
            <Text key={`${index}-`}>{content}</Text>
          )
        })}
        {model.description ? <Text dimColor>{model.description}</Text> : null}
      </Box>
      {model.explanation ? <Text dimColor>{model.explanation}</Text> : null}
      <Text>{model.question}</Text>
      {model.options.map((option, index) => {
        const selected = selection === index
        const editor = option.editableRule
          ? (ruleEditor ?? {
              text: option.editableRule.initialValue,
              cursor: Array.from(option.editableRule.initialValue).length,
            })
          : null
        const segments = editor ? composerEditorSegments(editor) : null
        return (
          <Text
            key={`${option.action}-${index}`}
            bold={selected}
            {...(selected ? { color: palette.brand } : {})}
          >
            {selected ? (screenReader ? 'Selected: ' : '❯ ') : '  '}
            {index + 1}. {option.label}
            {segments ? (
              screenReader || !selected ? (
                `: ${editor?.text ?? ''}`
              ) : (
                <Text>
                  : {segments.before}
                  <Text inverse>{segments.current ?? ' '}</Text>
                  {segments.after}
                </Text>
              )
            ) : null}
          </Text>
        )
      })}
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
