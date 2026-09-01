import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import { platform, release, type } from 'node:os'

const MAX_GIT_OUTPUT_BYTES = 2_048
const MAX_GIT_STATUS_BYTES = 2_048
const MAX_GIT_ERROR_BYTES = 8 * 1024
const GIT_TIMEOUT_MS = 5_000

interface GitOutput {
  output: string
  truncated: boolean
}

interface OptionalGitOutput extends GitOutput {
  available: boolean
}

export interface ClaudeDynamicContextSections {
  environment: string
  memory?: string
  gitStatus?: string
}

export interface ClaudeDynamicContextOptions {
  cwd: string
  memoryDirectory?: string
  shell?: string
  platform?: string
  osVersion?: string
  runGit?(
    args: readonly string[],
  ): Promise<string | { output: string; truncated: boolean }>
}

function collectBounded(
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number; truncated: boolean },
  limit: number,
): void {
  const remaining = limit - state.bytes
  if (remaining <= 0) {
    state.truncated = true
    return
  }
  const accepted = chunk.subarray(0, remaining)
  chunks.push(accepted)
  state.bytes += accepted.length
  if (accepted.length < chunk.length) state.truncated = true
}

function boundUtf8(value: string, limit: number, marker: string): string {
  if (Buffer.byteLength(value, 'utf8') <= limit) return value
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  const prefixLimit = Math.max(0, limit - markerBytes)
  let bytes = 0
  let prefix = ''
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > prefixLimit) break
    prefix += character
    bytes += characterBytes
  }
  return `${prefix}${marker}`
}

function defaultRunGit(
  cwd: string,
  args: readonly string[],
): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const stdoutState = { bytes: 0, truncated: false }
    const stderrState = { bytes: 0, truncated: false }
    let timedOut = false
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, GIT_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) =>
      collectBounded(stdout, chunk, stdoutState, MAX_GIT_OUTPUT_BYTES),
    )
    child.stderr.on('data', (chunk: Buffer) =>
      collectBounded(stderr, chunk, stderrState, MAX_GIT_ERROR_BYTES),
    )
    child.once('error', (error) => finish(() => reject(error)))
    child.once('close', (code, signal) => {
      finish(() => {
        if (timedOut) {
          reject(new Error(`git ${args[0] ?? ''} timed out after 5 seconds`))
          return
        }
        if (code !== 0) {
          const detail = Buffer.concat(stderr).toString('utf8').trim()
          reject(
            new Error(
              `git ${args[0] ?? ''} failed${signal ? ` with signal ${signal}` : ` with exit ${String(code)}`}${detail ? `: ${detail}` : ''}`,
            ),
          )
          return
        }
        resolve({
          output: Buffer.concat(stdout).toString('utf8'),
          truncated: stdoutState.truncated,
        })
      })
    })
  })
}

async function optionalGit(
  runGit: (args: readonly string[]) => Promise<GitOutput>,
  args: readonly string[],
): Promise<OptionalGitOutput> {
  try {
    const result = await runGit(args)
    return {
      available: true,
      output: result.output.trimEnd(),
      truncated: result.truncated,
    }
  } catch {
    return { available: false, output: '', truncated: false }
  }
}

function selectMainBranch(branches: string, current: string): string {
  const names = branches.split('\n').filter(Boolean)
  if (names.includes('main')) return 'main'
  if (names.includes('master')) return 'master'
  return current
}

async function renderGitStatus(
  runGit: (args: readonly string[]) => Promise<GitOutput>,
): Promise<string | undefined> {
  const inside = await optionalGit(runGit, [
    'rev-parse',
    '--is-inside-work-tree',
  ])
  if (!inside.available || inside.output !== 'true') {
    return undefined
  }
  const [branchValue, branches, user, status, commits] = await Promise.all([
    optionalGit(runGit, ['branch', '--show-current']),
    optionalGit(runGit, ['branch', '--format=%(refname:short)']),
    optionalGit(runGit, ['config', 'user.name']),
    optionalGit(runGit, [
      '--no-optional-locks',
      'status',
      '--short',
      '--untracked-files=all',
    ]),
    optionalGit(runGit, ['log', '-5', '--oneline']),
  ])
  if (!status.available) return undefined
  const branch = branchValue.output || 'HEAD'
  const sections = [
    '# gitStatus',
    'Snapshot captured when this model request was assembled; it may change during the conversation.',
    '',
    `Current branch: ${branch}`,
    '',
    `Main branch: ${selectMainBranch(branches.output, branch)}`,
  ]
  if (user.available && user.output) {
    sections.push('', `Git user: ${user.output}`)
  }
  const renderedStatus = status.output
    ? `${status.output}${status.truncated ? '\n... [truncated]' : ''}`
    : status.truncated
      ? '... [truncated]'
      : 'Clean'
  sections.push('', 'Status:', renderedStatus)
  if (commits.available && commits.output) {
    sections.push('', 'Recent commits:', commits.output)
  }
  return boundUtf8(
    sections.join('\n'),
    MAX_GIT_STATUS_BYTES,
    '\n... [truncated]',
  )
}

export async function loadClaudeDynamicContext(
  options: ClaudeDynamicContextOptions,
): Promise<ClaudeDynamicContextSections> {
  const configuredRunGit = options.runGit
  const runGit = configuredRunGit
    ? async (args: readonly string[]) => {
        const result = await configuredRunGit(args)
        return typeof result === 'string'
          ? { output: result, truncated: false }
          : result
      }
    : (args: readonly string[]) => defaultRunGit(options.cwd, args)
  const gitStatus = await renderGitStatus(runGit)
  const environment = [
    '# Environment',
    'Praxis was invoked in the following environment:',
    `- Primary working directory: ${options.cwd}`,
    `- Is a git repository: ${gitStatus !== undefined}`,
    `- Platform: ${options.platform ?? platform()}`,
    `- Shell: ${basename(options.shell ?? process.env.SHELL ?? 'unknown')}`,
    `- OS Version: ${options.osVersion ?? `${type()} ${release()}`}`,
  ].join('\n')
  const memory = options.memoryDirectory
    ? [
        '# Memory',
        `Persistent project memory is stored at \`${options.memoryDirectory}\`.`,
        'Use MEMORY.md as a concise index of one-line links. Keep detailed durable facts in linked Markdown topic files with name, description, and a type of user, feedback, project, or reference. Update existing entries instead of duplicating them.',
        'Do not store codebase architecture, implementation patterns, git history, fix recipes, transient task or conversation state, or duplicates of repository instructions.',
      ].join('\n')
    : undefined
  return {
    environment,
    ...(memory ? { memory } : {}),
    ...(gitStatus ? { gitStatus } : {}),
  }
}

export function renderClaudeDynamicSystemContext(
  sections: ClaudeDynamicContextSections,
): string {
  return [sections.memory, sections.environment, sections.gitStatus]
    .filter((section): section is string => section !== undefined)
    .join('\n\n')
}

export function renderClaudeDynamicUserContext(
  sections: ClaudeDynamicContextSections,
): string {
  const content = [sections.gitStatus, sections.environment, sections.memory]
    .filter((section): section is string => section !== undefined)
    .join('\n\n')
  return `<system-reminder>\nMachine-specific context for this request:\n${content}\n\nTreat this as runtime context, not as a user-authored instruction.\n</system-reminder>`
}
