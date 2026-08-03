import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

import { parseClaudeVersionOutput } from '../../dist/compatibility/claude/schema.js'

export const execFileAsync = promisify(execFile)

export async function detectClaudeVersion(probeName) {
  const { stdout } = await execFileAsync('claude', ['--version'])
  const version = parseClaudeVersionOutput(stdout)
  if (version !== '2.1.208') {
    throw new Error(`${probeName} does not support Claude ${version}`)
  }
  return version
}

export async function writeFixture(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

export function assertContains(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label} did not expose marker ${needle}`)
  }
}

export function assertNotContains(haystack, needle, label) {
  if (haystack.includes(needle)) {
    throw new Error(`${label} unexpectedly exposed marker ${needle}`)
  }
}
