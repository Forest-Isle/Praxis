#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { RuntimeEventSink } from './core/runtime.js'
import type { CliDependencies, CliIO } from './cli-runtime.js'

export {
  parseContextEnvironment,
  parseProviderEnvironment,
} from './providers/environment.js'
export type { CliDependencies, CliIO } from './cli-runtime.js'

const VERSION = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version

export async function run(
  argv: readonly string[],
  io?: CliIO,
  dependencies?: CliDependencies,
  signal?: AbortSignal,
): Promise<number> {
  const hasVersion = argv.includes('--version') || argv.includes('-v')
  const hasHelp = argv.includes('--help') || argv.includes('-h')
  if (hasVersion && !hasHelp) {
    if (io?.stdout) io.stdout(`${VERSION}\n`)
    else process.stdout.write(`${VERSION}\n`)
    return 0
  }
  const runtime = await import('./cli-runtime.js')
  const resolvedDependencies =
    dependencies === undefined
      ? runtime.createDefaultDependencies(fileURLToPath(import.meta.url))
      : dependencies
  return runtime.run(argv, io, resolvedDependencies, signal)
}

export async function createBackgroundWorkerRuntime(
  workerSink: RuntimeEventSink,
  dispatch: { argv: string[] },
  createService?: CliDependencies['createService'],
): Promise<Awaited<ReturnType<CliDependencies['createService']>>> {
  const runtime = await import('./cli-runtime.js')
  return runtime.createBackgroundWorkerRuntime(
    workerSink,
    dispatch,
    createService,
  )
}

function isDirectExecution(moduleUrl: string, argvPath: string | undefined) {
  if (!argvPath) return false
  try {
    return moduleUrl === pathToFileURL(realpathSync(argvPath)).href
  } catch {
    return false
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  try {
    process.exitCode = await run(
      process.argv.slice(2),
      undefined,
      undefined,
      controller.signal,
    )
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
  }
}
