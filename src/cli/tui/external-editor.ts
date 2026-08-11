import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'

export interface TuiEditorCommand {
  command: string
  args: readonly string[]
  displayName: string
}

export interface TuiEditorResult {
  content: string
  editorName: string
}

export interface TuiEditorOptions {
  cwd: string
  environment?: NodeJS.ProcessEnv
  signal?: AbortSignal
  tempRoot?: string
}

function parseEditorCommand(value: string): string[] {
  const words: string[] = []
  let word = ''
  let started = false
  let quote: 'single' | 'double' | null = null
  let escaped = false

  const finishWord = () => {
    if (!started) return
    words.push(word)
    word = ''
    started = false
  }

  for (const character of value) {
    if (escaped) {
      word += character
      started = true
      escaped = false
      continue
    }
    if (quote === 'single') {
      if (character === "'") quote = null
      else word += character
      started = true
      continue
    }
    if (quote === 'double') {
      if (character === '"') quote = null
      else if (character === '\\') escaped = true
      else word += character
      started = true
      continue
    }
    if (character === '\\') {
      escaped = true
      started = true
    } else if (character === "'") {
      quote = 'single'
      started = true
    } else if (character === '"') {
      quote = 'double'
      started = true
    } else if (/\s/u.test(character)) {
      finishWord()
    } else {
      word += character
      started = true
    }
  }

  if (quote) throw new Error('Editor command contains an unterminated quote')
  if (escaped) throw new Error('Editor command ends with an incomplete escape')
  finishWord()
  return words
}

function editorDisplayName(command: string): string {
  const name = basename(command) || command
  const first = name.at(0)
  return first ? first.toUpperCase() + name.slice(1) : 'Editor'
}

export function resolveTuiEditor(
  environment: NodeJS.ProcessEnv = process.env,
): TuiEditorCommand {
  const configured = [environment.VISUAL, environment.EDITOR].find((value) =>
    value?.trim(),
  )
  const words = parseEditorCommand(configured ?? 'vi')
  const command = words[0]
  if (!command) throw new Error('Editor command is empty')
  return {
    command,
    args: words.slice(1),
    displayName: editorDisplayName(command),
  }
}

async function runEditor(
  editor: TuiEditorCommand,
  promptPath: string,
  options: TuiEditorOptions,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor.command, [...editor.args, promptPath], {
      cwd: options.cwd,
      stdio: 'inherit',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    let settled = false
    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      if (code === 0) resolve()
      else if (code !== null) {
        reject(
          new Error(
            `${editor.displayName} quit unexpectedly (exit code ${code})`,
          ),
        )
      } else {
        reject(
          new Error(
            `${editor.displayName} quit unexpectedly${signal ? ` (signal ${signal})` : ''}`,
          ),
        )
      }
    })
  })
}

export async function openTuiEditorFile(
  path: string,
  options: TuiEditorOptions,
): Promise<{ editorName: string }> {
  const editor = resolveTuiEditor(options.environment)
  await runEditor(editor, path, options)
  return { editorName: editor.displayName }
}

export async function editTuiPrompt(
  prompt: string,
  options: TuiEditorOptions,
): Promise<TuiEditorResult> {
  const editor = resolveTuiEditor(options.environment)
  const parent = options.tempRoot ?? tmpdir()
  const directory = join(parent, `praxis-editor-${randomUUID()}`)
  const promptPath = join(directory, `claude-prompt-${randomUUID()}.md`)
  await mkdir(directory, { mode: 0o700, recursive: false })
  try {
    await writeFile(promptPath, prompt, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    await runEditor(editor, promptPath, options)
    return {
      content: await readFile(promptPath, 'utf8'),
      editorName: editor.displayName,
    }
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}
