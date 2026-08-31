import { spawn } from 'node:child_process'

import {
  redactSensitiveText,
  sanitizeChildEnvironment,
  sensitiveEnvironmentValues,
} from './sensitive-data.js'

export interface ProcessResult {
  stdout: string
  stderr: string
  output: string
  code: number
  timedOut: boolean
  truncated: boolean
  controlOutput?: string
}

export interface BoundedProcessRunnerOptions {
  cwd: string
  maxOutputBytes: number
}

export interface RunProcessOptions {
  command: string
  args: readonly string[]
  timeoutMs: number
  cwd?: string
  signal?: AbortSignal
  onOutput?: (output: string) => void | Promise<void>
  env?: Readonly<Record<string, string>>
  controlOutputBytes?: number
  controlOutputFd?: number
  scriptInput?: string
}

function abortError(): DOMException {
  return new DOMException('Tool execution aborted', 'AbortError')
}

function takeUtf8Prefix(
  content: string,
  maxBytes: number,
): { content: string; bytes: number; truncated: boolean } {
  const encodedBytes = Buffer.byteLength(content)
  if (encodedBytes <= maxBytes) {
    return { content, bytes: encodedBytes, truncated: false }
  }
  let prefix = ''
  let bytes = 0
  for (const character of content) {
    const characterBytes = Buffer.byteLength(character)
    if (bytes + characterBytes > maxBytes) break
    prefix += character
    bytes += characterBytes
  }
  return { content: prefix, bytes, truncated: true }
}

function redactSensitivePrefix(
  content: string,
  sensitiveValues: readonly string[],
  maxRawBytes: number,
): string {
  let redacted = ''
  let index = 0
  let rawBytes = 0
  while (index < content.length && rawBytes < maxRawBytes) {
    const sensitiveValue = sensitiveValues.find((value) =>
      content.startsWith(value, index),
    )
    if (sensitiveValue) {
      redacted += redactSensitiveText(sensitiveValue, [sensitiveValue])
      rawBytes += Buffer.byteLength(sensitiveValue)
      index += sensitiveValue.length
      continue
    }
    const codePoint = content.codePointAt(index)
    if (codePoint === undefined) break
    const character = String.fromCodePoint(codePoint)
    const characterBytes = Buffer.byteLength(character)
    if (rawBytes + characterBytes > maxRawBytes) break
    redacted += character
    rawBytes += characterBytes
    index += character.length
  }
  return redacted
}

function unstableSensitiveSuffixLength(
  content: string,
  sensitiveValues: readonly string[],
): number {
  let longest = 0
  for (const value of sensitiveValues) {
    const limit = Math.min(content.length, value.length - 1)
    for (let length = limit; length > longest; length -= 1) {
      if (content.endsWith(value.slice(0, length))) {
        longest = length
        break
      }
    }
  }
  return longest
}

function renderOutput(
  content: string,
  sensitiveValues: readonly string[],
  maxOutputBytes: number,
  rawBytes: number,
  complete: boolean,
): string {
  const safeContent = complete
    ? content
    : content.slice(
        0,
        content.length -
          unstableSensitiveSuffixLength(content, sensitiveValues),
      )
  const redacted = redactSensitivePrefix(
    safeContent,
    sensitiveValues,
    maxOutputBytes,
  )
  const retained = takeUtf8Prefix(redacted, maxOutputBytes)
  return `${retained.content}${
    rawBytes > maxOutputBytes || retained.truncated
      ? '\n[output truncated]'
      : ''
  }`
}

export function joinedProcessOutput(result: ProcessResult): string {
  if (!result.stdout) return result.stderr
  if (!result.stderr) return result.stdout
  return `${result.stdout}${result.stdout.endsWith('\n') ? '' : '\n'}${result.stderr}`
}

export class BoundedProcessRunner {
  constructor(private readonly options: BoundedProcessRunnerOptions) {}

  run(options: RunProcessOptions): Promise<ProcessResult> {
    if (options.signal?.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      const sensitiveValues = sensitiveEnvironmentValues(process.env)
      const longestSensitiveValueBytes = sensitiveValues.reduce(
        (longest, value) => Math.max(longest, Buffer.byteLength(value)),
        0,
      )
      const rawOutputLimit =
        this.options.maxOutputBytes + Math.max(3, longestSensitiveValueBytes)
      const controlOutputFd =
        options.controlOutputBytes === undefined
          ? undefined
          : (options.controlOutputFd ?? 3)
      const scriptInputFd = options.scriptInput === undefined ? undefined : 4
      if (
        controlOutputFd !== undefined &&
        scriptInputFd !== undefined &&
        controlOutputFd === scriptInputFd
      ) {
        reject(
          new Error('Process control output and script input FDs conflict'),
        )
        return
      }
      const highestFd = Math.max(2, controlOutputFd ?? 2, scriptInputFd ?? 2)
      const stdio: Array<'ignore' | 'pipe'> = Array.from(
        { length: highestFd + 1 },
        () => 'ignore' as const,
      )
      stdio[1] = 'pipe'
      stdio[2] = 'pipe'
      if (controlOutputFd !== undefined) stdio[controlOutputFd] = 'pipe'
      if (scriptInputFd !== undefined) stdio[scriptInputFd] = 'pipe'
      const child = spawn(options.command, options.args, {
        cwd: options.cwd ?? this.options.cwd,
        detached: process.platform !== 'win32',
        env: { ...sanitizeChildEnvironment(), ...options.env },
        stdio,
      })
      const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
      const combined: Buffer[] = []
      const retainedBytes = { stdout: 0, stderr: 0, combined: 0 }
      const controlChunks: Buffer[] = []
      let controlBytes = 0
      let outputBytes = 0
      let timedOut = false
      let settled = false
      let outputUpdates = Promise.resolve()
      let outputUpdateError: unknown

      const queueOutputUpdate = (output: string) => {
        if (!options.onOutput) return
        outputUpdates = outputUpdates.then(async () => {
          if (outputUpdateError !== undefined) return
          try {
            await options.onOutput?.(output)
          } catch (error) {
            outputUpdateError = error
          }
        })
      }

      const updateLiveOutput = () => {
        const raw = Buffer.concat(combined).toString('utf8')
        const output = renderOutput(
          raw,
          sensitiveValues,
          this.options.maxOutputBytes,
          outputBytes,
          false,
        )
        queueOutputUpdate(output)
      }
      const retain = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        outputBytes = Math.min(
          this.options.maxOutputBytes + 1,
          outputBytes + chunk.length,
        )
        const remaining = rawOutputLimit - retainedBytes[stream]
        if (remaining > 0) {
          const retained = chunk.subarray(0, remaining)
          chunks[stream].push(retained)
          retainedBytes[stream] += retained.length
        }
        const combinedRemaining = rawOutputLimit - retainedBytes.combined
        if (combinedRemaining > 0) {
          const retained = chunk.subarray(0, combinedRemaining)
          combined.push(retained)
          retainedBytes.combined += retained.length
        }
        updateLiveOutput()
      }
      if (!child.stdout || !child.stderr) {
        reject(new Error('Process output streams were not created'))
        return
      }
      child.stdout.on('data', (chunk: Buffer) => retain('stdout', chunk))
      child.stderr.on('data', (chunk: Buffer) => retain('stderr', chunk))
      const controlStream =
        controlOutputFd === undefined ? undefined : child.stdio[controlOutputFd]
      if (controlStream) {
        controlStream.on('data', (chunk: Buffer) => {
          const remaining = Math.max(
            0,
            (options.controlOutputBytes ?? 0) - controlBytes,
          )
          if (remaining <= 0) return
          const retained = chunk.subarray(0, remaining)
          controlChunks.push(retained)
          controlBytes += retained.length
        })
        child.once('exit', () => {
          setImmediate(() => controlStream.destroy())
        })
      }
      const scriptStream =
        scriptInputFd === undefined ? undefined : child.stdio[scriptInputFd]
      if (scriptStream) {
        scriptStream.on('error', () => {
          // The child process result remains authoritative if it exits before
          // consuming the complete script.
        })
        if (!('end' in scriptStream)) {
          reject(new Error('Process script input stream is not writable'))
          return
        }
        scriptStream.end(options.scriptInput)
        child.once('exit', () => {
          setImmediate(() => scriptStream.destroy())
        })
      }

      const kill = () => {
        if (child.pid === undefined) return
        try {
          if (process.platform === 'win32') child.kill('SIGKILL')
          else process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reject(error)
        }
      }
      const cancel = () => kill()
      options.signal?.addEventListener('abort', cancel, { once: true })
      const timeout = setTimeout(() => {
        timedOut = true
        kill()
      }, options.timeoutMs)

      child.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        options.signal?.removeEventListener('abort', cancel)
        reject(error)
      })
      child.once('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        options.signal?.removeEventListener('abort', cancel)
        if (options.signal?.aborted) {
          reject(abortError())
          return
        }
        const rawStdout = Buffer.concat(chunks.stdout).toString('utf8')
        const rawStderr = Buffer.concat(chunks.stderr).toString('utf8')
        const stdoutRawBudget = Math.min(
          retainedBytes.stdout,
          this.options.maxOutputBytes,
        )
        const stderrRawBudget = Math.min(
          retainedBytes.stderr,
          this.options.maxOutputBytes - stdoutRawBudget,
        )
        const stdout = takeUtf8Prefix(
          redactSensitivePrefix(rawStdout, sensitiveValues, stdoutRawBudget),
          this.options.maxOutputBytes,
        )
        const stderr = takeUtf8Prefix(
          redactSensitivePrefix(rawStderr, sensitiveValues, stderrRawBudget),
          this.options.maxOutputBytes - stdout.bytes,
        )
        const truncated =
          outputBytes > this.options.maxOutputBytes ||
          stdout.truncated ||
          stderr.truncated
        const combinedRaw = Buffer.concat(combined).toString('utf8')
        const output = renderOutput(
          combinedRaw,
          sensitiveValues,
          this.options.maxOutputBytes,
          outputBytes,
          true,
        )
        queueOutputUpdate(output)
        void outputUpdates.then(() => {
          if (outputUpdateError !== undefined) {
            reject(outputUpdateError)
            return
          }
          resolve({
            stdout: `${stdout.content}${truncated ? '\n[output truncated]' : ''}`,
            stderr: stderr.content,
            output,
            code: code ?? 1,
            timedOut,
            truncated,
            ...(options.controlOutputBytes === undefined
              ? {}
              : {
                  controlOutput: Buffer.concat(controlChunks).toString('utf8'),
                }),
          })
        }, reject)
      })
    })
  }
}
