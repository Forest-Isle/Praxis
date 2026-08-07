import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PDFDocument, StandardFonts } from 'pdf-lib'

import { afterEach, describe, expect, it } from 'vitest'

import { LocalToolRegistry } from './local-tools.js'

const roots: string[] = []

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-tools-'))
  roots.push(root)
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  return { root, cwd }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('LocalToolRegistry', () => {
  it('matches Claude Read schema and preserves native PDF media results', async () => {
    const { cwd } = await workspace()
    const document = await PDFDocument.create()
    const font = await document.embedFont(StandardFonts.Helvetica)
    for (const pageNumber of [1, 2]) {
      const page = document.addPage([240, 240])
      page.drawText(`Page ${pageNumber}`, { x: 24, y: 190, font, size: 18 })
    }
    const pdfPath = join(cwd, 'fixture.pdf')
    await writeFile(pdfPath, await document.save())
    const registry = new LocalToolRegistry({ cwd })
    const definition = registry
      .definitions()
      .find((tool) => tool.name === 'Read')
    expect(definition).toMatchObject({
      description: expect.stringContaining(
        'By default, it reads up to 2000 lines',
      ),
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          offset: { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          limit: {
            exclusiveMinimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
          },
          pages: { type: 'string' },
        },
      },
    })

    const context = { cwd, toolResultDirectory: join(cwd, 'tool-results') }
    const whole = await registry.execute(
      await registry.prepare(
        { id: 'read-pdf', name: 'Read', input: { file_path: pdfPath } },
        context,
      ),
      context,
    )
    expect(whole).toMatchObject({
      content: expect.stringContaining('PDF file read:'),
      documents: [{ type: 'document', mediaType: 'application/pdf' }],
      nativeToolUseResult: {
        type: 'pdf',
        file: {
          filePath: await realpath(pdfPath),
          originalSize: (await stat(pdfPath)).size,
        },
      },
    })
    const pages = await registry.execute(
      await registry.prepare(
        {
          id: 'read-pdf-pages',
          name: 'Read',
          input: { file_path: pdfPath, pages: '1-2' },
        },
        context,
      ),
      context,
    )
    expect(pages).toMatchObject({
      content: expect.stringContaining('PDF pages extracted: 2 page(s)'),
      images: [
        { type: 'image', mediaType: 'image/jpeg' },
        { type: 'image', mediaType: 'image/jpeg' },
      ],
      nativeToolUseResult: {
        type: 'parts',
        file: { count: 2 },
      },
    })
  })

  it('reports validated code-review findings with the Claude schema', async () => {
    const { cwd } = await workspace()
    const registry = new LocalToolRegistry({ cwd, enableReportFindings: true })
    const definition = registry
      .definitions()
      .find((tool) => tool.name === 'ReportFindings')
    expect(definition).toMatchObject({
      name: 'ReportFindings',
      inputSchema: {
        required: ['findings'],
        additionalProperties: false,
        properties: {
          level: {
            enum: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
          findings: { maxItems: 32 },
        },
      },
    })
    const call = await registry.prepare(
      {
        id: 'report-findings',
        name: 'ReportFindings',
        input: {
          level: 'high',
          findings: [
            {
              file: 'src/index.ts',
              line: 7,
              summary: 'Incorrect result',
              failure_scenario: 'Input 0 returns 1',
              category: 'correctness',
              verdict: 'CONFIRMED',
            },
          ],
        },
      },
      { cwd },
    )
    await expect(registry.execute(call, { cwd })).resolves.toEqual({
      content:
        '{"count":1,"level":"high","findings":[{"file":"src/index.ts","line":7,"summary":"Incorrect result","failure_scenario":"Input 0 returns 1","category":"correctness","verdict":"CONFIRMED"}]}',
      isError: false,
    })
    await expect(
      registry.prepare(
        {
          id: 'invalid-findings',
          name: 'ReportFindings',
          input: { findings: [], extra: true },
        },
        { cwd },
      ),
    ).rejects.toThrow('Unknown ReportFindings input field extra')
  })

  it('binds filesystem and shell tools to the execution cwd', async () => {
    const { root, cwd } = await workspace()
    const isolated = join(root, 'isolated')
    await mkdir(isolated)
    const registry = new LocalToolRegistry({ cwd })
    const context = { cwd: isolated }

    const write = await registry.prepare(
      {
        id: 'isolated-write',
        name: 'Write',
        input: { file_path: 'marker.txt', content: 'isolated' },
      },
      context,
    )
    await registry.execute(write, context)

    await expect(readFile(join(isolated, 'marker.txt'), 'utf8')).resolves.toBe(
      'isolated',
    )
    await expect(
      readFile(join(cwd, 'marker.txt'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })

    const bash = await registry.prepare(
      { id: 'isolated-bash', name: 'Bash', input: { command: 'pwd' } },
      context,
    )
    await expect(registry.execute(bash, context)).resolves.toMatchObject({
      content: `${await realpath(isolated)}\n`,
      isError: false,
    })
  })

  it('reads supported images as bounded native multimodal results', async () => {
    const { cwd } = await workspace()
    const base64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='
    const imagePath = join(cwd, 'pixel.png')
    await writeFile(imagePath, Buffer.from(base64, 'base64'))
    const registry = new LocalToolRegistry({ cwd })
    const context = { cwd }
    const call = await registry.prepare(
      {
        id: 'read-image',
        name: 'Read',
        input: { file_path: 'pixel.png' },
      },
      context,
    )

    await expect(registry.execute(call, context)).resolves.toEqual({
      content: '',
      images: [{ type: 'image', mediaType: 'image/png', data: base64 }],
      isError: false,
      accessedPaths: [await realpath(imagePath)],
    })
    for (const input of [
      { file_path: 'pixel.png', offset: 1 },
      { file_path: 'pixel.png', limit: 1 },
    ]) {
      const sliced = await registry.prepare(
        { id: 'read-image-lines', name: 'Read', input },
        context,
      )
      await expect(registry.execute(sliced, context)).rejects.toThrow(
        'offset and limit are not supported for images',
      )
    }
  })

  it('provides bounded read, write, edit, search, and shell tools', async () => {
    const { cwd } = await workspace()
    await writeFile(join(cwd, 'source.txt'), 'alpha\nbeta\nalpha\n')
    const registry = new LocalToolRegistry({ cwd, maxOutputBytes: 64 })
    const context = { cwd }

    expect(registry.definitions().map((tool) => tool.name)).toEqual([
      'Read',
      'Write',
      'Edit',
      'NotebookEdit',
      'Glob',
      'Grep',
      'Bash',
    ])

    const read = await registry.prepare(
      {
        id: 'read',
        name: 'Read',
        input: { file_path: 'source.txt', offset: 2, limit: 1 },
      },
      context,
    )
    expect(read.input.file_path).toBe(await realpath(join(cwd, 'source.txt')))
    await expect(registry.execute(read, context)).resolves.toEqual({
      content: '2\tbeta',
      isError: false,
      accessedPaths: [await realpath(join(cwd, 'source.txt'))],
      nativeToolUseResult: {
        type: 'text',
        file: {
          filePath: await realpath(join(cwd, 'source.txt')),
          content: 'beta',
          numLines: 1,
          startLine: 2,
          totalLines: 4,
        },
      },
    })

    const write = await registry.prepare(
      {
        id: 'write',
        name: 'Write',
        input: { file_path: 'output.txt', content: 'before' },
      },
      context,
    )
    await expect(registry.execute(write, context)).resolves.toMatchObject({
      isError: false,
    })
    const edit = await registry.prepare(
      {
        id: 'edit',
        name: 'Edit',
        input: {
          file_path: 'output.txt',
          old_string: 'before',
          new_string: 'after',
        },
      },
      context,
    )
    await expect(registry.execute(edit, context)).resolves.toMatchObject({
      isError: false,
    })
    await expect(readFile(join(cwd, 'output.txt'), 'utf8')).resolves.toBe(
      'after',
    )

    const grep = await registry.prepare(
      {
        id: 'grep',
        name: 'Grep',
        input: { pattern: 'alpha', path: '.' },
      },
      context,
    )
    const grepResult = await registry.execute(grep, context)
    expect(grepResult).toMatchObject({ isError: false })
    expect(grepResult.content).toContain('source.txt:1:alpha')

    const shell = await registry.prepare(
      {
        id: 'shell',
        name: 'Bash',
        input: { command: 'printf shell-ok' },
      },
      context,
    )
    await expect(registry.execute(shell, context)).resolves.toEqual({
      content: 'shell-ok',
      isError: false,
    })
  })

  it('renders and edits notebook cells only after a successful Read', async () => {
    const { cwd } = await workspace()
    const notebookPath = join(cwd, 'sample.ipynb')
    await writeFile(
      notebookPath,
      JSON.stringify({
        cells: [
          {
            cell_type: 'markdown',
            id: 'intro',
            metadata: { tag: 'keep' },
            source: ['# Old\n', 'body'],
          },
        ],
        metadata: { retained: true },
        nbformat: 4,
        nbformat_minor: 5,
      }),
    )
    const registry = new LocalToolRegistry({ cwd })
    const read = await registry.prepare(
      { id: 'read-notebook', name: 'Read', input: { file_path: notebookPath } },
      { cwd },
    )
    const readResult = await registry.execute(read, { cwd })
    expect(readResult.content).toBe(
      '<cell id="intro"><cell_type>markdown</cell_type># Old\nbody</cell id="intro">',
    )

    const replaceCall = {
      id: 'replace-cell',
      name: 'NotebookEdit',
      input: {
        notebook_path: notebookPath,
        cell_id: 'intro',
        new_source: '# New\nbody',
      },
    }
    await expect(
      registry.prepare(replaceCall, { cwd, messages: [] }),
    ).rejects.toThrow('not been read yet')
    const messages = [
      { role: 'assistant' as const, content: '', toolCalls: [read] },
      {
        role: 'tool' as const,
        toolCallId: read.id,
        content: readResult.content,
        isError: false,
      },
    ]
    const replace = await registry.prepare(replaceCall, { cwd, messages })
    await expect(registry.execute(replace, { cwd, messages })).resolves.toEqual(
      {
        content: 'Updated cell intro with # New\nbody',
        isError: false,
      },
    )
    await expect(readFile(notebookPath, 'utf8')).resolves.toContain(
      '"source": "# New\\nbody"',
    )

    await expect(
      registry.prepare(
        {
          ...replaceCall,
          id: 'relative-notebook',
          input: { ...replaceCall.input, notebook_path: 'sample.ipynb' },
        },
        { cwd, messages },
      ),
    ).rejects.toThrow('must be an absolute path')
  })

  it('finds files with Claude-compatible paths, ordering, and errors', async () => {
    const { cwd } = await workspace()
    await mkdir(join(cwd, 'src', '.hidden'), { recursive: true })
    const oldPath = join(cwd, 'src', 'old.ts')
    const hiddenPath = join(cwd, 'src', '.hidden', 'secret.ts')
    const newPath = join(cwd, 'src', 'new.ts')
    await Promise.all([
      writeFile(oldPath, ''),
      writeFile(hiddenPath, ''),
      writeFile(newPath, ''),
      writeFile(join(cwd, '.gitignore'), 'src/new.ts\n'),
    ])
    await Promise.all([
      utimes(oldPath, 1_000, 1_000),
      utimes(hiddenPath, 2_000, 2_000),
      utimes(newPath, 3_000, 3_000),
    ])
    const registry = new LocalToolRegistry({ cwd })
    const context = { cwd }

    const relative = await registry.prepare(
      { id: 'glob-relative', name: 'Glob', input: { pattern: '*.ts' } },
      context,
    )
    expect(relative.input).toEqual({ pattern: '*.ts' })
    await expect(registry.execute(relative, context)).resolves.toEqual({
      content: 'src/old.ts\nsrc/.hidden/secret.ts\nsrc/new.ts',
      isError: false,
    })

    const absolute = await registry.prepare(
      {
        id: 'glob-absolute',
        name: 'Glob',
        input: { pattern: '*.ts', path: join(cwd, 'src') },
      },
      context,
    )
    await expect(registry.execute(absolute, context)).resolves.toEqual({
      content: `${oldPath}\n${hiddenPath}\n${newPath}`,
      isError: false,
    })
    await expect(
      registry.prepare(
        {
          id: 'glob-missing',
          name: 'Glob',
          input: { pattern: '*', path: join(cwd, 'missing') },
        },
        context,
      ),
    ).rejects.toThrow('<tool_use_error>Directory does not exist:')
    await expect(
      registry.prepare(
        {
          id: 'glob-file',
          name: 'Glob',
          input: { pattern: '*', path: oldPath },
        },
        context,
      ),
    ).rejects.toThrow(`<tool_use_error>Path is not a directory: ${oldPath}`)

    const boundedRegistry = new LocalToolRegistry({ cwd, maxOutputBytes: 10 })
    const bounded = await boundedRegistry.prepare(
      { id: 'glob-bounded', name: 'Glob', input: { pattern: '*.ts' } },
      context,
    )
    await expect(boundedRegistry.execute(bounded, context)).resolves.toEqual({
      content: 'src/old.ts\n[output truncated]',
      isError: false,
    })

    const manyDirectory = join(cwd, 'many')
    await mkdir(manyDirectory)
    await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        writeFile(join(manyDirectory, `${index}.txt`), ''),
      ),
    )
    const timeoutRegistry = new LocalToolRegistry({
      cwd,
      maxShellTimeoutMs: 1,
    })
    const timeout = await timeoutRegistry.prepare(
      { id: 'glob-timeout', name: 'Glob', input: { pattern: '**/*' } },
      context,
    )
    await expect(timeoutRegistry.execute(timeout, context)).resolves.toEqual({
      content: 'Search timed out after 1ms',
      isError: true,
    })
  })

  it('rejects lexical and symlink paths outside the workspace', async () => {
    const { root, cwd } = await workspace()
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(cwd, 'escape'))
    const registry = new LocalToolRegistry({ cwd })

    await expect(
      registry.prepare(
        {
          id: 'traversal',
          name: 'Read',
          input: { file_path: '../outside/secret.txt' },
        },
        { cwd },
      ),
    ).rejects.toThrow('outside workspace')
    await expect(
      registry.prepare(
        {
          id: 'symlink',
          name: 'Read',
          input: { file_path: 'escape/secret.txt' },
        },
        { cwd },
      ),
    ).rejects.toThrow('outside workspace')

    const protectedPath = join(cwd, 'protected.txt')
    await writeFile(protectedPath, 'keep')
    const approved = await registry.prepare(
      {
        id: 'swapped',
        name: 'Write',
        input: { file_path: 'approved.txt', content: 'overwrite' },
      },
      { cwd },
    )
    await symlink(protectedPath, join(cwd, 'approved.txt'))
    await expect(registry.execute(approved, { cwd })).rejects.toThrow(
      'changed after permission approval',
    )
    await expect(readFile(protectedPath, 'utf8')).resolves.toBe('keep')
  })

  it('allows configured task output roots for Read only', async () => {
    const { root, cwd } = await workspace()
    const taskRoot = join(root, 'task-output')
    await mkdir(taskRoot)
    const outputPath = join(taskRoot, 'background.output')
    await writeFile(outputPath, 'BACKGROUND_OUTPUT')
    const registry = new LocalToolRegistry({
      cwd,
      additionalReadDirectories: [taskRoot],
    })
    const read = await registry.prepare(
      {
        id: 'read-task-output',
        name: 'Read',
        input: { file_path: outputPath },
      },
      { cwd },
    )
    await expect(registry.execute(read, { cwd })).resolves.toMatchObject({
      content: '1\tBACKGROUND_OUTPUT',
    })
    await expect(
      registry.prepare(
        {
          id: 'write-task-output',
          name: 'Write',
          input: { file_path: outputPath, content: 'MUTATED' },
        },
        { cwd },
      ),
    ).rejects.toThrow('outside workspace')
  })

  it('ignores an absent additional Read root for workspace files', async () => {
    const { root, cwd } = await workspace()
    await writeFile(join(cwd, 'workspace.txt'), 'WORKSPACE')
    const registry = new LocalToolRegistry({
      cwd,
      additionalReadDirectories: [join(root, 'not-created-yet')],
    })
    const read = await registry.prepare(
      {
        id: 'read-workspace-before-task-root',
        name: 'Read',
        input: { file_path: 'workspace.txt' },
      },
      { cwd },
    )
    await expect(registry.execute(read, { cwd })).resolves.toMatchObject({
      content: '1\tWORKSPACE',
    })
  })

  it('limits standard file tools to the workspace and configured shared roots', async () => {
    const { root, cwd } = await workspace()
    const memoryDirectory = join(root, 'config', 'projects', 'key', 'memory')
    const outside = join(root, 'outside')
    await Promise.all([
      mkdir(memoryDirectory, { recursive: true }),
      mkdir(outside),
    ])
    await Promise.all([
      writeFile(join(memoryDirectory, 'details.md'), 'shared detail'),
      writeFile(join(outside, 'secret.md'), 'secret'),
    ])
    await symlink(outside, join(memoryDirectory, 'escape'))
    const registry = new LocalToolRegistry({
      cwd,
      sharedMemoryDirectory: memoryDirectory,
    })
    const context = { cwd }

    expect(
      registry.definitions().find((tool) => tool.name === 'Read')?.description,
    ).toContain(memoryDirectory)
    const read = await registry.prepare(
      {
        id: 'memory-read',
        name: 'Read',
        input: { file_path: join(memoryDirectory, 'details.md') },
      },
      context,
    )
    await expect(registry.execute(read, context)).resolves.toMatchObject({
      content: '1\tshared detail',
      isError: false,
    })
    const write = await registry.prepare(
      {
        id: 'memory-write',
        name: 'Write',
        input: {
          file_path: join(memoryDirectory, 'praxis.md'),
          content: 'created by Praxis',
        },
      },
      context,
    )
    await registry.execute(write, context)
    const edit = await registry.prepare(
      {
        id: 'memory-edit',
        name: 'Edit',
        input: {
          file_path: join(memoryDirectory, 'praxis.md'),
          old_string: 'Praxis',
          new_string: 'Claude and Praxis',
        },
      },
      context,
    )
    await registry.execute(edit, context)
    await expect(
      readFile(join(memoryDirectory, 'praxis.md'), 'utf8'),
    ).resolves.toBe('created by Claude and Praxis')

    await expect(
      registry.prepare(
        {
          id: 'outside-read',
          name: 'Read',
          input: { file_path: join(outside, 'secret.md') },
        },
        context,
      ),
    ).rejects.toThrow('outside workspace')
    await expect(
      registry.prepare(
        {
          id: 'memory-symlink',
          name: 'Read',
          input: { file_path: join(memoryDirectory, 'escape', 'secret.md') },
        },
        context,
      ),
    ).rejects.toThrow('outside workspace')
    await expect(
      registry.prepare(
        {
          id: 'outside-grep',
          name: 'Grep',
          input: { pattern: 'shared', path: memoryDirectory },
        },
        context,
      ),
    ).rejects.toThrow('outside workspace')
  })

  it('allows file and search tools in additional canonical roots without symlink escape', async () => {
    const { root, cwd } = await workspace()
    const additional = join(root, 'additional')
    const outside = join(root, 'outside')
    await Promise.all([mkdir(additional), mkdir(outside)])
    await Promise.all([
      writeFile(join(additional, 'allowed.txt'), 'ADDITIONAL_MARKER'),
      writeFile(join(additional, 'allowed.ts'), 'ADDITIONAL_GLOB_MARKER'),
      writeFile(
        join(additional, 'allowed.ipynb'),
        JSON.stringify({
          cells: [
            {
              cell_type: 'markdown',
              id: 'additional-cell',
              metadata: {},
              source: 'before',
            },
          ],
          metadata: {},
          nbformat: 4,
        }),
      ),
      writeFile(join(outside, 'secret.txt'), 'SECRET_MARKER'),
      writeFile(join(outside, 'secret.ipynb'), '{}'),
    ])
    await symlink(outside, join(additional, 'escape'))
    const registry = new LocalToolRegistry({
      cwd,
      additionalDirectories: [additional],
    })
    const context = { cwd }

    const read = await registry.prepare(
      {
        id: 'additional-read',
        name: 'Read',
        input: { file_path: join(additional, 'allowed.txt') },
      },
      context,
    )
    await expect(registry.execute(read, context)).resolves.toMatchObject({
      content: '1\tADDITIONAL_MARKER',
      isError: false,
    })
    const grep = await registry.prepare(
      {
        id: 'additional-grep',
        name: 'Grep',
        input: { pattern: 'ADDITIONAL', path: additional },
      },
      context,
    )
    await expect(registry.execute(grep, context)).resolves.toMatchObject({
      isError: false,
    })
    const glob = await registry.prepare(
      {
        id: 'additional-glob',
        name: 'Glob',
        input: { pattern: '*.ts', path: additional },
      },
      context,
    )
    await expect(registry.execute(glob, context)).resolves.toEqual({
      content: join(additional, 'allowed.ts'),
      isError: false,
    })
    const notebookPath = join(additional, 'allowed.ipynb')
    const notebookRead = await registry.prepare(
      {
        id: 'additional-notebook-read',
        name: 'Read',
        input: { file_path: notebookPath },
      },
      context,
    )
    const notebookResult = await registry.execute(notebookRead, context)
    const messages = [
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [notebookRead],
      },
      {
        role: 'tool' as const,
        toolCallId: notebookRead.id,
        content: notebookResult.content,
        isError: false,
      },
    ]
    const notebookEdit = await registry.prepare(
      {
        id: 'additional-notebook-edit',
        name: 'NotebookEdit',
        input: {
          notebook_path: notebookPath,
          cell_id: 'additional-cell',
          new_source: 'after',
        },
      },
      { cwd, messages },
    )
    await registry.execute(notebookEdit, { cwd, messages })
    expect(JSON.parse(await readFile(notebookPath, 'utf8'))).toMatchObject({
      cells: [{ id: 'additional-cell', source: 'after' }],
    })
    await expect(
      registry.prepare(
        {
          id: 'additional-escape',
          name: 'Read',
          input: { file_path: join(additional, 'escape', 'secret.txt') },
        },
        context,
      ),
    ).rejects.toThrow('outside workspace')
    await expect(
      registry.prepare(
        {
          id: 'additional-glob-escape',
          name: 'Glob',
          input: { pattern: '*.ts', path: join(additional, 'escape') },
        },
        context,
      ),
    ).rejects.toThrow('outside workspace')
    await expect(
      registry.prepare(
        {
          id: 'additional-notebook-escape',
          name: 'NotebookEdit',
          input: {
            notebook_path: join(additional, 'escape', 'secret.ipynb'),
            cell_id: 'secret',
            new_source: 'escaped',
          },
        },
        { cwd, messages },
      ),
    ).rejects.toThrow('outside workspace')
  })

  it('bounds shell output, times out, and propagates cancellation', async () => {
    const { cwd } = await workspace()
    const registry = new LocalToolRegistry({
      cwd,
      maxOutputBytes: 16,
      maxShellTimeoutMs: 100,
    })

    const bounded = await registry.prepare(
      {
        id: 'bounded',
        name: 'Bash',
        input: { command: "printf '12345678901234567890'" },
      },
      { cwd },
    )
    const boundedResult = await registry.execute(bounded, { cwd })
    expect(boundedResult.content).toBe('1234567890123456\n[output truncated]')

    const timeout = await registry.prepare(
      {
        id: 'timeout',
        name: 'Bash',
        input: { command: 'sleep 1', timeout: 20 },
      },
      { cwd },
    )
    await expect(registry.execute(timeout, { cwd })).resolves.toEqual({
      content: 'Command timed out after 20ms',
      isError: true,
    })

    const controller = new AbortController()
    const cancelled = await registry.prepare(
      {
        id: 'cancelled',
        name: 'Bash',
        input: { command: 'sleep 1' },
      },
      { cwd, signal: controller.signal },
    )
    const execution = registry.execute(cancelled, {
      cwd,
      signal: controller.signal,
    })
    controller.abort()
    await expect(execution).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not expose ambient credentials to shell processes', async () => {
    const { cwd } = await workspace()
    const credentials = {
      PRAXIS_TEST_API_KEY: 'local-tool-secret-canary',
      AWS_ACCESS_KEY_ID: 'local-tool-access-key',
      GITHUB_PAT: 'local-tool-pat',
      NPM_CONFIG__AUTH: 'local-tool-npm-auth',
      PGPASSWORD: 'local-tool-pg-password',
    }
    const previous = Object.fromEntries(
      Object.keys(credentials).map((name) => [name, process.env[name]]),
    )
    Object.assign(process.env, credentials)
    const script = `process.stdout.write(JSON.stringify(${JSON.stringify(Object.keys(credentials))}.map(name => process.env[name] ?? 'missing')) + ':local-tool-secret-canary')`
    const registry = new LocalToolRegistry({ cwd })

    try {
      const shell = await registry.prepare(
        {
          id: 'environment',
          name: 'Bash',
          input: {
            command: `node -e ${JSON.stringify(script)}`,
          },
        },
        { cwd },
      )
      await expect(registry.execute(shell, { cwd })).resolves.toEqual({
        content: `${JSON.stringify(Object.keys(credentials).map(() => 'missing'))}:[REDACTED]`,
        isError: false,
      })
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('applies shell output bounds after credential redaction', async () => {
    const { cwd } = await workspace()
    const secret = 'boundary-secret-canary'
    const variable = 'PRAXIS_TEST_API_KEY'
    const previous = process.env[variable]
    process.env[variable] = secret
    const registry = new LocalToolRegistry({ cwd, maxOutputBytes: 8 })

    try {
      const shell = await registry.prepare(
        {
          id: 'bounded-redaction',
          name: 'Bash',
          input: { command: `printf 1234${secret}` },
        },
        { cwd },
      )
      const result = await registry.execute(shell, { cwd })
      expect(result.content).toBe('1234[RED\n[output truncated]')
      expect(result.content).not.toContain(secret)
      expect(result.content).not.toContain(secret.slice(0, 8))
    } finally {
      if (previous === undefined) delete process.env[variable]
      else process.env[variable] = previous
    }
  })

  it('does not expose split UTF-8 characters at the shell output bound', async () => {
    const { cwd } = await workspace()
    const registry = new LocalToolRegistry({ cwd, maxOutputBytes: 7 })
    const shell = await registry.prepare(
      {
        id: 'bounded-utf8',
        name: 'Bash',
        input: { command: "printf 'abcd😀'" },
      },
      { cwd },
    )

    await expect(registry.execute(shell, { cwd })).resolves.toEqual({
      content: 'abcd\n[output truncated]',
      isError: false,
    })
  })

  it('rejects edits whose replacement output exceeds the file bound', async () => {
    const { cwd } = await workspace()
    await writeFile(join(cwd, 'expand.txt'), 'aaaa')
    const registry = new LocalToolRegistry({ cwd, maxFileBytes: 10 })
    const edit = await registry.prepare(
      {
        id: 'expand',
        name: 'Edit',
        input: {
          file_path: 'expand.txt',
          old_string: 'a',
          new_string: 'long',
          replace_all: true,
        },
      },
      { cwd },
    )

    await expect(registry.execute(edit, { cwd })).rejects.toThrow(
      'Edited content exceeds 10 bytes',
    )
  })
})
