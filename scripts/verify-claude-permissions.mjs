import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import {
  detectClaudeVersion,
  runClaudeJson,
  writeFixture,
} from './lib/claude-probe.mjs'

function permissionPath(path) {
  return path.startsWith('/') ? `/${path}` : path
}

function contentBlocks(entry) {
  const content = entry?.message?.content
  return Array.isArray(content) ? content : []
}

async function runReadProbe({ cwd, configRoot, path, expectedError }) {
  const response = await runClaudeJson(
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '2',
      '--tools',
      'Read',
      '--permission-mode',
      'dontAsk',
      '--output-format',
      'json',
      `Use the Read tool exactly once on ${path}. Do not use any other path or tool. Then state whether the read succeeded.`,
    ],
    cwd,
    configRoot,
  )
  if (typeof response.session_id !== 'string') {
    throw new Error('Claude permission probe returned no session ID')
  }
  const paths = resolveClaudePaths({
    configDir: configRoot,
    cwd,
    sessionId: response.session_id,
  })
  const entries = (await readFile(paths.sessionFile, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
  const toolCall = entries
    .flatMap(contentBlocks)
    .find(
      (block) =>
        block.type === 'tool_use' &&
        block.name === 'Read' &&
        block.input?.file_path === path,
    )
  if (!toolCall) throw new Error(`Claude did not call Read for ${path}`)
  const result = entries
    .flatMap(contentBlocks)
    .find(
      (block) =>
        block.type === 'tool_result' && block.tool_use_id === toolCall.id,
    )
  if (!result || (result.is_error === true) !== expectedError) {
    throw new Error(
      `Claude Read permission mismatch for ${path}: ${JSON.stringify(result)}`,
    )
  }
}

async function runBashProbe({ cwd, configRoot, command }) {
  const response = await runClaudeJson(
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '2',
      '--tools',
      'Bash',
      '--permission-mode',
      'dontAsk',
      '--output-format',
      'json',
      `Use the Bash tool exactly once with this exact command: ${command}`,
    ],
    cwd,
    configRoot,
  )
  if (typeof response.session_id !== 'string') {
    throw new Error('Claude Bash permission probe returned no session ID')
  }
  const paths = resolveClaudePaths({
    configDir: configRoot,
    cwd,
    sessionId: response.session_id,
  })
  const entries = (await readFile(paths.sessionFile, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
  const toolCall = entries
    .flatMap(contentBlocks)
    .find(
      (block) =>
        block.type === 'tool_use' &&
        block.name === 'Bash' &&
        block.input?.command === command,
    )
  if (!toolCall) throw new Error(`Claude did not call Bash with ${command}`)
  const result = entries
    .flatMap(contentBlocks)
    .find(
      (block) =>
        block.type === 'tool_result' && block.tool_use_id === toolCall.id,
    )
  if (!result || result.is_error === true) {
    throw new Error(
      `Claude Bash :* permission mismatch: ${JSON.stringify(result)}`,
    )
  }
}

const probeRoot = await mkdtemp(join(tmpdir(), 'praxis-permission-compat-'))

try {
  const configRoot = join(probeRoot, 'config')
  const workspace = join(probeRoot, 'workspace')
  await mkdir(workspace, { recursive: true })
  const cwd = await realpath(workspace)
  const allowedPath = join(cwd, 'allowed.txt')
  const askedPath = join(cwd, 'asked.txt')
  const deniedPath = join(cwd, 'denied.txt')
  const bashCommand = 'printf praxis-permission allowed-argument'
  await Promise.all([
    writeFixture(allowedPath, 'ALLOWED_PERMISSION_MARKER\n'),
    writeFixture(askedPath, 'ASKED_PERMISSION_MARKER\n'),
    writeFixture(deniedPath, 'DENIED_PERMISSION_MARKER\n'),
    writeFixture(
      join(configRoot, 'settings.json'),
      JSON.stringify({
        permissions: {
          allow: [
            `Read(${permissionPath(join(cwd, 'allowed*'))})`,
            'Bash(printf praxis-permission:*)',
          ],
        },
      }),
    ),
    writeFixture(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: {
          ask: [`Read(${permissionPath(askedPath)})`],
          deny: [`Read(${permissionPath(deniedPath)})`],
        },
      }),
    ),
  ])

  const version = await detectClaudeVersion('Permission probe')
  await runReadProbe({
    cwd,
    configRoot,
    path: allowedPath,
    expectedError: false,
  })
  await runReadProbe({
    cwd,
    configRoot,
    path: askedPath,
    expectedError: true,
  })
  await runReadProbe({
    cwd,
    configRoot,
    path: deniedPath,
    expectedError: true,
  })
  await runBashProbe({ cwd, configRoot, command: bashCommand })
  console.log(
    `Claude ${version} permission compatibility passed: user/project allow, ask, deny, // paths, glob, and Bash :*`,
  )
} finally {
  await rm(probeRoot, { recursive: true })
}
