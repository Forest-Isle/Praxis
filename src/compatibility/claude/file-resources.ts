import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path'

export interface ClaudeFileResource {
  fileId: string
  relativePath: string
}

export interface ClaudeFileResourceDownload {
  fileId: string
  relativePath: string
  path: string
  success: boolean
  bytesWritten?: number
  error?: string
}

export interface ClaudeFileResourceConfig {
  cwd: string
  sessionId: string
  apiKey: string
  baseUrl: string
  headers?: Readonly<Record<string, string>>
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  concurrency?: number
  maxFileSizeBytes?: number
  timeoutMs?: number
}

const DEFAULT_CONCURRENCY = 5
const DEFAULT_MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 500
const DEFAULT_TIMEOUT_MS = 60_000

function validFileId(fileId: string): boolean {
  return fileId.length > 0 && !/[\\/\s\0]/u.test(fileId)
}

function safeRelativePath(relativePath: string): string {
  if (
    !relativePath ||
    relativePath.includes('\0') ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Invalid file resource path: ${relativePath || '<empty>'}`)
  }
  const cleaned = relativePath.replaceAll('\\', '/')
  const normalized = normalize(cleaned)
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(
      `File resource path escapes the session uploads directory: ${relativePath}`,
    )
  }
  return normalized
}

export function parseClaudeFileSpecs(
  values: readonly string[],
): ClaudeFileResource[] {
  const resources: ClaudeFileResource[] = []
  for (const value of values) {
    for (const spec of value.split(/\s+/u).filter(Boolean)) {
      const separator = spec.indexOf(':')
      if (separator <= 0 || separator === spec.length - 1) {
        throw new Error(
          `Invalid --file spec ${spec}; expected file_id:relative_path`,
        )
      }
      const fileId = spec.slice(0, separator)
      if (!validFileId(fileId)) {
        throw new Error(`Invalid --file file ID: ${fileId}`)
      }
      const path = safeRelativePath(spec.slice(separator + 1))
      resources.push({ fileId, relativePath: path })
    }
  }
  return resources
}

export function buildClaudeFileResourcePath(
  cwd: string,
  sessionId: string,
  relativePath: string,
): string {
  const path = safeRelativePath(relativePath)
  const uploads = resolve(cwd, sessionId, 'uploads')
  const target = resolve(uploads, path)
  const escape = relative(uploads, target)
  if (escape === '..' || escape.startsWith('../') || isAbsolute(escape)) {
    throw new Error(
      `File resource path escapes the session uploads directory: ${relativePath}`,
    )
  }
  return target
}

function filesEndpoint(baseUrl: string, fileId: string): string {
  const base = baseUrl.replace(/\/+$/u, '')
  const path = base.endsWith('/v1') ? `${base}/files` : `${base}/v1/files`
  return `${path}/${encodeURIComponent(fileId)}/content`
}

function retryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429
}

async function delay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolveDelay, reject) => {
    const timer = setTimeout(resolveDelay, milliseconds)
    if (!signal) return
    if (signal.aborted) {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('File download aborted'))
      return
    }
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('File download aborted'))
      },
      { once: true },
    )
  })
}

async function downloadOne(
  resource: ClaudeFileResource,
  config: ClaudeFileResourceConfig,
): Promise<ClaudeFileResourceDownload> {
  const path = buildClaudeFileResourcePath(
    config.cwd,
    config.sessionId,
    resource.relativePath,
  )
  const fetcher = config.fetchImpl ?? fetch
  const maxSize = config.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES
  let lastError = 'download failed'

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const timeoutSignal = AbortSignal.timeout(
        config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )
      const requestSignal = config.signal
        ? AbortSignal.any([config.signal, timeoutSignal])
        : timeoutSignal
      const response = await fetcher(
        filesEndpoint(config.baseUrl, resource.fileId),
        {
          headers: {
            ...(config.headers ?? {
              Authorization: `Bearer ${config.apiKey}`,
            }),
            'anthropic-version':
              config.headers?.['anthropic-version'] ?? '2023-06-01',
            'anthropic-beta':
              config.headers?.['anthropic-beta'] ?? 'files-api-2025-04-14',
          },
          signal: requestSignal,
        },
      )
      if (!response.ok) {
        lastError = `HTTP ${response.status}`
        if (!retryableStatus(response.status) || attempt === MAX_RETRIES) {
          return { ...resource, path, success: false, error: lastError }
        }
      } else {
        const contentLength = response.headers.get('content-length')
        if (contentLength && Number(contentLength) > maxSize) {
          return {
            ...resource,
            path,
            success: false,
            error: `file exceeds ${maxSize} bytes`,
          }
        }
        const content = Buffer.from(await response.arrayBuffer())
        if (content.length > maxSize) {
          return {
            ...resource,
            path,
            success: false,
            error: `file exceeds ${maxSize} bytes`,
          }
        }
        const temporary = `${path}.praxis-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`
        await mkdir(dirname(path), { recursive: true })
        try {
          await writeFile(temporary, content, { flag: 'wx' })
          await rename(temporary, path)
        } finally {
          await rm(temporary, { force: true })
        }
        return {
          ...resource,
          path,
          success: true,
          bytesWritten: content.length,
        }
      }
    } catch (error) {
      if (config.signal?.aborted) throw error
      lastError = error instanceof Error ? error.message : String(error)
      if (attempt === MAX_RETRIES) {
        return { ...resource, path, success: false, error: lastError }
      }
    }
    await delay(RETRY_DELAY_MS * 2 ** (attempt - 1), config.signal)
  }
  return { ...resource, path, success: false, error: lastError }
}

export async function downloadClaudeFileResources(
  resources: readonly ClaudeFileResource[],
  config: ClaudeFileResourceConfig,
): Promise<ClaudeFileResourceDownload[]> {
  if (resources.length === 0) return []
  const concurrency = Math.max(
    1,
    Math.floor(config.concurrency ?? DEFAULT_CONCURRENCY),
  )
  const results: ClaudeFileResourceDownload[] = new Array(resources.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next
      next += 1
      const resource = resources[index]
      if (!resource) return
      results[index] = await downloadOne(resource, config)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, resources.length) }, worker),
  )
  return results
}
