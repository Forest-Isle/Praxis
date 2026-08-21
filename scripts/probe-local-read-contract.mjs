import { execFile } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { PDFDocument, StandardFonts } from 'pdf-lib'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-local-read-probe-'))
const cwd = join(root, 'work')
const configRoot = join(root, 'config')
const requests = []
const responses = []
let messageNumber = 0

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  )
}

function messageStart() {
  messageNumber += 1
  return {
    type: 'message_start',
    message: {
      id: `msg_read_${messageNumber}`,
      type: 'message',
      role: 'assistant',
      model: 'fixture-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  }
}

function toolEvents(id, input) {
  return [
    messageStart(),
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id, name: 'Read', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]
}

function textEvents(text) {
  return [
    messageStart(),
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]
}

function toolResult(request, id) {
  return request.messages
    ?.flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .find((block) => block.type === 'tool_result' && block.tool_use_id === id)
}

async function pdf(pageCount) {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let page = 1; page <= pageCount; page += 1) {
    const output = document.addPage([300, 300])
    output.drawText(`Fixture page ${page}`, { x: 30, y: 240, font, size: 18 })
  }
  return document.save()
}

const server = createServer(async (request, response) => {
  if (request.method === 'HEAD') {
    response.writeHead(200).end()
    return
  }
  let source = ''
  request.setEncoding('utf8')
  for await (const chunk of request) source += chunk
  if (!source || !request.url?.startsWith('/v1/messages')) {
    response.writeHead(404).end()
    return
  }
  requests.push(JSON.parse(source))
  const events = responses.shift()
  if (!events) throw new Error('Read provider response queue exhausted')
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
  )
})

try {
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(configRoot, { recursive: true }),
  ])
  const textPath = join(cwd, 'lines.txt')
  const smallPdfPath = join(cwd, 'small.pdf')
  const largePdfPath = join(cwd, 'large.pdf')
  await Promise.all([
    writeFile(textPath, 'alpha\nbeta\ngamma\n'),
    writeFile(smallPdfPath, await pdf(2)),
    writeFile(largePdfPath, await pdf(12)),
  ])
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Read fixture server did not bind a TCP port')
  }
  responses.push(
    toolEvents('read-text', { file_path: textPath, offset: 2, limit: 1 }),
    toolEvents('read-pdf', { file_path: smallPdfPath }),
    toolEvents('read-pdf-pages', { file_path: largePdfPath, pages: '2-3' }),
    textEvents('READ_PROBE_DONE'),
  )
  await execFileAsync(
    'claude',
    [
      '-p',
      '--safe-mode',
      '--dangerously-skip-permissions',
      '--tools',
      'Read,Write,Edit,Bash',
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      '4',
      '--output-format',
      'json',
      'run read fixtures',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
    },
  )
  const claudeRequests = requests.splice(0)
  responses.push(
    toolEvents('read-text', { file_path: textPath, offset: 2, limit: 1 }),
    toolEvents('read-pdf', { file_path: smallPdfPath }),
    toolEvents('read-pdf-pages', { file_path: largePdfPath, pages: '2-3' }),
    textEvents('READ_PROBE_DONE'),
  )
  const praxis = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), 'dist', 'cli.js'),
      '-p',
      '--no-session-persistence',
      '--dangerously-skip-permissions',
      '--tools',
      'Read,Write,Edit,Bash',
      '--output-format',
      'json',
      '--',
      'run read fixtures',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_API_KEY: 'fixture-key',
        PRAXIS_MODEL: 'fixture-model',
        PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
    },
  )
  const praxisResult = JSON.parse(praxis.stdout)
  assert(
    praxisResult.type === 'result' &&
      praxisResult.is_error === false &&
      praxisResult.result === 'READ_PROBE_DONE',
    `Praxis Read probe failed: ${praxis.stdout}`,
  )
  const praxisRequests = requests.splice(0)
  const selectedSchemas = (request) =>
    canonical(
      Object.fromEntries(
        (request?.tools ?? [])
          .filter((tool) =>
            ['Read', 'Write', 'Edit', 'Bash'].includes(tool.name),
          )
          .map((tool) => [tool.name, tool.input_schema]),
      ),
    )
  assert(
    JSON.stringify(selectedSchemas(praxisRequests[0])) ===
      JSON.stringify(selectedSchemas(claudeRequests[0])),
    `Praxis local tool schemas differ from Claude: ${JSON.stringify({ praxis: selectedSchemas(praxisRequests[0]), claude: selectedSchemas(claudeRequests[0]) })}`,
  )
  const text = toolResult(claudeRequests[1], 'read-text')
  const wholePdf = toolResult(claudeRequests[2], 'read-pdf')
  const pagedPdf = toolResult(claudeRequests[3], 'read-pdf-pages')
  const praxisText = toolResult(praxisRequests[1], 'read-text')
  const praxisWholePdf = toolResult(praxisRequests[2], 'read-pdf')
  const praxisPagedPdf = toolResult(praxisRequests[3], 'read-pdf-pages')
  const textContent = (result) =>
    Array.isArray(result?.content)
      ? result.content.find((block) => block.type === 'text')?.text
      : result?.content
  const normalizedTextContent = (result) =>
    textContent(result)
      ?.replace(
        /\n\n<system-reminder>\n<total_tokens>\d+ tokens left<\/total_tokens>\n<\/system-reminder>$/u,
        '',
      )
      .replaceAll('/private/var/', '/var/')
  const claudePagedPdfUnavailable = normalizedTextContent(pagedPdf)?.startsWith(
    'pdftoppm is not installed.',
  )
  for (const [label, actual, expected] of [
    ['text', praxisText, text],
    ['whole PDF', praxisWholePdf, wholePdf],
    ['paged PDF', praxisPagedPdf, pagedPdf],
  ]) {
    if (label === 'paged PDF' && claudePagedPdfUnavailable) {
      assert(
        normalizedTextContent(actual)?.startsWith(
          'PDF pages extracted: 2 page(s)',
        ),
        `Praxis paged PDF extraction failed: ${JSON.stringify(textContent(actual))}`,
      )
      continue
    }
    assert(
      normalizedTextContent(actual) === normalizedTextContent(expected),
      `Praxis ${label} text result differs: ${JSON.stringify({ actual: textContent(actual), expected: textContent(expected) })}`,
    )
  }
  const mediaBlocks = (request) =>
    request.messages
      ?.flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      )
      .filter(
        (block) =>
          block.type === 'document' ||
          block.type === 'image' ||
          (block.type === 'tool_result' && Array.isArray(block.content)),
      )
  const summarize = (result) => ({
    ...result,
    content: Array.isArray(result?.content)
      ? result.content.map((block) => ({
          ...block,
          source:
            block.source?.type === 'base64'
              ? {
                  ...block.source,
                  dataBytes: Buffer.from(block.source.data, 'base64').length,
                  data: '<base64>',
                }
              : block.source,
        }))
      : result?.content,
  })
  console.log(
    JSON.stringify(
      {
        text: summarize(text),
        wholePdf: summarize(wholePdf),
        pagedPdf: summarize(pagedPdf),
        wholePdfMedia: mediaBlocks(claudeRequests[2]).map((block) => ({
          type: block.type,
          mediaType: block.source?.media_type,
          dataBytes:
            typeof block.source?.data === 'string'
              ? Buffer.from(block.source.data, 'base64').length
              : undefined,
          nestedTypes: Array.isArray(block.content)
            ? block.content.map((nested) => nested.type)
            : undefined,
        })),
        pagedPdfMedia: mediaBlocks(claudeRequests[3]).map((block) => ({
          type: block.type,
          mediaType: block.source?.media_type,
          dataBytes:
            typeof block.source?.data === 'string'
              ? Buffer.from(block.source.data, 'base64').length
              : undefined,
          nestedTypes: Array.isArray(block.content)
            ? block.content.map((nested) => nested.type)
            : undefined,
        })),
      },
      null,
      2,
    ),
  )
  const mediaSignature = (request) =>
    mediaBlocks(request).map((block) => [block.type, block.source?.media_type])
  assert(
    JSON.stringify(mediaSignature(praxisRequests[2])) ===
      JSON.stringify(mediaSignature(claudeRequests[2])),
    `Praxis whole PDF media differs from Claude: ${JSON.stringify({ praxis: mediaSignature(praxisRequests[2]), claude: mediaSignature(claudeRequests[2]) })}`,
  )
  if (claudePagedPdfUnavailable)
    assert(
      mediaSignature(praxisRequests[3]).length > 0,
      'Praxis paged PDF extraction omitted media',
    )
  else
    assert(
      JSON.stringify(mediaSignature(praxisRequests[3])) ===
        JSON.stringify(mediaSignature(claudeRequests[3])),
      `Praxis paged PDF media differs from Claude: ${JSON.stringify({ praxis: mediaSignature(praxisRequests[3]), claude: mediaSignature(claudeRequests[3]) })}`,
    )
  console.log('Claude/Praxis local Read compatibility checks passed.')
} finally {
  await new Promise((resolve) => server.close(resolve)).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}
