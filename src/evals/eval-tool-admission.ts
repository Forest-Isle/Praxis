import { resolve } from 'node:path'

import type { ModelToolCall } from '../core/runtime.js'
import { validateBashSemantics } from '../permissions/bash-ast.js'
import { validateBashPathSafety } from '../permissions/bash-path-safety.js'

export interface EvalToolAdmissionOptions {
  cwd: string
  homeDirectory: string
  allowedTools: readonly string[]
  additionalDirectories: readonly string[]
}

function commandInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return
  const command = (input as { command?: unknown }).command
  return typeof command === 'string' ? command : undefined
}

export function isEvalToolCallPreapproved(
  call: ModelToolCall,
  options: EvalToolAdmissionOptions,
): boolean {
  if (!options.allowedTools.includes(call.name)) return false
  if (call.name !== 'Bash') return true

  const command = commandInput(call.input)
  if (command === undefined) return false
  if (!validateBashSemantics(command).safe) return false

  const cwd = resolve(options.cwd)
  const roots = [
    cwd,
    ...options.additionalDirectories.map((directory) =>
      resolve(cwd, directory),
    ),
  ]
  return validateBashPathSafety(command, {
    cwd,
    homeDirectory: options.homeDirectory,
    readRoots: roots,
    writeRoots: roots,
    permissionMode: 'acceptEdits',
  }).safe
}
