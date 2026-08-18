import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  buildClaudeFileResourcePath,
  downloadClaudeFileResources,
  parseClaudeFileSpecs,
} from './file-resources.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('Claude startup file resources', () => {
  it('parses specs and rejects traversal', () => {
    expect(parseClaudeFileSpecs(['file_a:docs/../notes.txt'])).toEqual([
      { fileId: 'file_a', relativePath: 'notes.txt' },
    ])
    expect(() => parseClaudeFileSpecs(['file_a:../notes.txt'])).toThrow(
      'escapes',
    )
    expect(() =>
      buildClaudeFileResourcePath('/tmp/work', 'session', '/tmp/x'),
    ).toThrow('Invalid file resource path')
  })

  it('downloads into session uploads and sends the bearer key', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'praxis-file-resources-'))
    roots.push(cwd)
    const requests: {
      url: string
      authorization: string | null
      anthropicVersion: string | null
      anthropicBeta: string | null
    }[] = []

    const results = await downloadClaudeFileResources(
      [
        { fileId: 'file_a', relativePath: 'docs/a.txt' },
        { fileId: 'file_b', relativePath: 'images/b.png' },
      ],
      {
        cwd,
        sessionId: 'session-1',
        apiKey: 'secret',
        baseUrl: 'https://files.example.test/v1',
        fetchImpl: async (input, init) => {
          const request = new Request(input, init)
          requests.push({
            url: request.url,
            authorization: request.headers.get('authorization'),
            anthropicVersion: request.headers.get('anthropic-version'),
            anthropicBeta: request.headers.get('anthropic-beta'),
          })
          return new Response(
            request.url.endsWith('file_a/content') ? 'A' : 'B',
          )
        },
      },
    )

    expect(results).toMatchObject([
      { fileId: 'file_a', success: true, bytesWritten: 1 },
      { fileId: 'file_b', success: true, bytesWritten: 1 },
    ])
    await expect(
      readFile(join(cwd, 'session-1/uploads/docs/a.txt'), 'utf8'),
    ).resolves.toBe('A')
    await expect(
      readFile(join(cwd, 'session-1/uploads/images/b.png'), 'utf8'),
    ).resolves.toBe('B')
    expect(requests).toHaveLength(2)
    expect(
      requests.every((request) => request.authorization === 'Bearer secret'),
    ).toBe(true)
    expect(
      requests.every((request) => request.anthropicVersion === '2023-06-01'),
    ).toBe(true)
    expect(
      requests.every(
        (request) => request.anthropicBeta === 'files-api-2025-04-14',
      ),
    ).toBe(true)
    expect(requests[0]?.url).toContain('/v1/files/file_')
  })

  it('preserves custom headers and merges the required Files API headers', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'praxis-file-resources-'))
    roots.push(cwd)
    const requests: {
      url: string
      authorization: string | null
      anthropicVersion: string | null
      anthropicBeta: string | null
      custom: string | null
    }[] = []

    const results = await downloadClaudeFileResources(
      [{ fileId: 'file_c', relativePath: 'docs/c.txt' }],
      {
        cwd,
        sessionId: 'session-2',
        apiKey: 'secret',
        baseUrl: 'https://files.example.test/v1',
        headers: {
          Authorization: 'Bearer custom-token',
          'X-Praxis-Custom': 'kept',
          'anthropic-beta': 'files-api-2025-04-14,oauth-2025-04-20',
        },
        fetchImpl: async (input, init) => {
          const request = new Request(input, init)
          requests.push({
            url: request.url,
            authorization: request.headers.get('authorization'),
            anthropicVersion: request.headers.get('anthropic-version'),
            anthropicBeta: request.headers.get('anthropic-beta'),
            custom: request.headers.get('x-praxis-custom'),
          })
          return new Response('C')
        },
      },
    )

    expect(results).toMatchObject([
      { fileId: 'file_c', success: true, bytesWritten: 1 },
    ])
    await expect(
      readFile(join(cwd, 'session-2/uploads/docs/c.txt'), 'utf8'),
    ).resolves.toBe('C')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.authorization).toBe('Bearer custom-token')
    expect(requests[0]?.custom).toBe('kept')
    expect(requests[0]?.anthropicVersion).toBe('2023-06-01')
    expect(requests[0]?.anthropicBeta).toBe(
      'files-api-2025-04-14,oauth-2025-04-20',
    )
  })

  it('returns a warning result for non-retryable HTTP failures', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'praxis-file-resources-'))
    roots.push(cwd)
    const [result] = await downloadClaudeFileResources(
      [{ fileId: 'missing', relativePath: 'missing.txt' }],
      {
        cwd,
        sessionId: 'session-1',
        apiKey: 'secret',
        baseUrl: 'https://files.example.test/v1',
        fetchImpl: async () => new Response('missing', { status: 404 }),
      },
    )
    expect(result).toMatchObject({
      fileId: 'missing',
      success: false,
      error: 'HTTP 404',
    })
  })
})
