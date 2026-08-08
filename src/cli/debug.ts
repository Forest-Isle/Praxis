import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import type { RuntimeEvent, RuntimeEventSink } from '../core/runtime.js'
import {
  redactSensitiveValue,
  sensitiveEnvironmentValues,
} from '../platform/sensitive-data.js'

export interface CliDebugOptions {
  filter?: string | true
  file?: string
  cwd: string
  stderr?: (message: string) => void
}

export interface CliDebugSink {
  eventSink: RuntimeEventSink
  close(): Promise<void>
}

function matchesFilter(event: RuntimeEvent, filter: string | true): boolean {
  if (filter === true) return true
  return JSON.stringify(event).toLowerCase().includes(filter.toLowerCase())
}

export function createCliDebugSink(
  base: RuntimeEventSink,
  options: CliDebugOptions,
): CliDebugSink {
  const file = options.file ? resolve(options.cwd, options.file) : undefined
  const sensitiveValues = sensitiveEnvironmentValues(process.env)
  let writes = Promise.resolve()
  let directoryReady: Promise<void> | undefined
  const write = (line: string) => {
    if (!file) return
    directoryReady ??= mkdir(dirname(file), { recursive: true }).then(
      () => undefined,
    )
    writes = writes
      .then(async () => {
        await directoryReady
        await appendFile(file, line)
      })
      .then(() => undefined)
      .catch(() => undefined)
  }
  const eventSink: RuntimeEventSink = (event) => {
    base(event)
    if (!matchesFilter(event, options.filter ?? true)) return
    const safeEvent = redactSensitiveValue(event, sensitiveValues)
    const line = `${new Date().toISOString()} ${JSON.stringify(safeEvent)}\n`
    write(line)
    options.stderr?.(`debug: ${line}`)
  }
  return { eventSink, close: () => writes }
}
