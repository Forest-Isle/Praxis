import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import {
  runSelfUpdateTransaction,
  type SelfUpdateLayout,
  type TransactionRunner,
} from './self-update-transaction.js'

const execFileAsync = promisify(execFile)
const DEFAULT_PACKAGE_NAME = 'praxis-agent'
const DEFAULT_TIMEOUT_MS = 120_000

export type SelfUpdateOperation = 'install' | 'update'

export interface SelfUpdateOptions {
  operation: SelfUpdateOperation
  target?: string
  force?: boolean
  packageName?: string
  npmExecutable?: string
  timeoutMs?: number
  signal?: AbortSignal
  layout?: SelfUpdateLayout
  run?: SelfUpdateRunner
}

export interface SelfUpdateRunnerOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
  maxBuffer?: number
  signal?: AbortSignal
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
  try {
    const result = await execFileAsync(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      signal: options.signal,
    })
    return {
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    }
  } catch (error) {
    options.signal?.throwIfAborted()
    throw new Error('self-update subprocess failed', { cause: error })
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

export async function runSelfUpdate(
  options: SelfUpdateOptions,
): Promise<SelfUpdateResult> {
  const packageName = options.packageName ?? DEFAULT_PACKAGE_NAME
  if (!validPackageName(packageName)) {
    throw new Error(`Invalid Praxis package name: ${packageName}`)
  }
  const operation = options.operation
  const force = options.force === true
  const target = requireTarget(
    options.target ?? (operation === 'install' ? 'stable' : 'latest'),
  )
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
  let result: { output: string }
  try {
    const transactionRunner: TransactionRunner = runner
    result = await runSelfUpdateTransaction({
      packageName,
      target,
      force,
      npmExecutable,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      run: transactionRunner,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.layout ? { layout: options.layout } : {}),
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
    output: result.output,
  }
}
