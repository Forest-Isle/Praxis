import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DEFAULT_PACKAGE_NAME = 'praxis-agent'
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export type SelfUpdateOperation = 'install' | 'update'

export interface SelfUpdateOptions {
  operation: SelfUpdateOperation
  target?: string
  force?: boolean
  packageName?: string
  npmExecutable?: string
  timeoutMs?: number
  run?: SelfUpdateRunner
}

export interface SelfUpdateRunnerOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
  maxBuffer?: number
}

export type SelfUpdateRunner = (
  executable: string,
  args: readonly string[],
  options: SelfUpdateRunnerOptions,
) => Promise<{ stdout: string; stderr: string }>

export interface SelfUpdateResult {
  type: 'self-update'
  operation: SelfUpdateOperation
  package: string
  target: string
  force: boolean
  command: readonly string[]
  output: string
}

const runCommand: SelfUpdateRunner = async (executable, args, options) => {
  const result = await execFileAsync(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
  })
  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  }
}

function validPackageName(value: string): boolean {
  return /^(?:@[^/\s]+\/)?[^/\s]+$/u.test(value)
}

function validTarget(value: string): boolean {
  return (
    /^(?:stable|latest|next|beta|canary)$/u.test(value) ||
    /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)
  )
}

function requireTarget(value: string | undefined): string {
  const target = value ?? 'stable'
  if (!validTarget(target)) {
    throw new Error(
      'install target must be stable, latest, next, beta, canary, or a semantic version',
    )
  }
  return target
}

function commandOutput(stdout: string, stderr: string): string {
  const output = `${stdout.trim()}${stderr.trim() ? `\n${stderr.trim()}` : ''}`
  return output.length > 0 ? output : 'completed'
}

export async function runSelfUpdate(
  options: SelfUpdateOptions,
): Promise<SelfUpdateResult> {
  const packageName = options.packageName ?? DEFAULT_PACKAGE_NAME
  if (!validPackageName(packageName)) {
    throw new Error(`Invalid Praxis package name: ${packageName}`)
  }
  const operation = options.operation
  const force = options.force === true
  const target =
    operation === 'install' ? requireTarget(options.target) : 'latest'
  const npmExecutable =
    options.npmExecutable ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm')
  const spec = `${packageName}@${target}`
  const args = [
    'install',
    '--global',
    '--no-fund',
    '--no-audit',
    '--ignore-scripts',
    ...(force ? ['--force'] : []),
    spec,
  ]
  const runner = options.run ?? runCommand
  let result: { stdout: string; stderr: string }
  try {
    result = await runner(npmExecutable, args, {
      env: process.env,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Praxis ${operation} failed: ${message}`, {
      cause: error,
    })
  }
  return {
    type: 'self-update',
    operation,
    package: packageName,
    target,
    force,
    command: [npmExecutable, ...args],
    output: commandOutput(result.stdout, result.stderr),
  }
}
