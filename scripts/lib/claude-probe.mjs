import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

import { parseClaudeVersionOutput } from '../../dist/compatibility/claude/schema.js'

export const execFileAsync = promisify(execFile)

export async function detectClaudeVersion(
  probeName,
  executable = process.env.PRAXIS_CLAUDE_BINARY ?? 'claude',
) {
  const { stdout } = await execFileAsync(executable, ['--version'])
  const version = parseClaudeVersionOutput(stdout)
  return version
}

export async function runClaudeJson(args, cwd, configRoot, extraEnv = {}) {
  const executable = process.env.PRAXIS_CLAUDE_BINARY ?? 'claude'
  const { stdout } = await execFileAsync(executable, args, {
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
      CLAUDE_CONFIG_DIR: configRoot,
    },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  })
  return JSON.parse(stdout)
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
