import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { parseClaudeVersionOutput } from '../compatibility/claude/schema.js'

const execFileAsync = promisify(execFile)

export type VersionCommand = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string }>

const executeVersionCommand: VersionCommand = async (file, args) => {
  const { stdout } = await execFileAsync(file, [...args], { encoding: 'utf8' })
  return { stdout }
}

export async function detectInstalledClaudeVersion(
  execute: VersionCommand = executeVersionCommand,
): Promise<string> {
  const { stdout } = await execute('claude', ['--version'])
  return parseClaudeVersionOutput(stdout)
}
