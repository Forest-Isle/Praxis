import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readlink,
  realpath,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { resolveClaudeProjectMemoryDirectory } from '../dist/compatibility/claude/shared-resources.js'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-tui-compat-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'work')
const movedCwd = join(root, 'moved-work')
const sharedRoot = join(root, 'shared-access')
const installRoot = join(root, 'install')
const binRoot = join(root, 'bin')
const claude = '/tmp/praxis-claude-pin-21208/node_modules/.bin/claude'
const pluginRoot = join(
  configRoot,
  'plugins',
  'cache',
  'inline',
  'hooks-fixture',
  '1.0.0',
)
const pluginHooks = join(pluginRoot, 'hooks', 'hooks.json')
const pluginReloader = join(binRoot, 'reload-plugin.mjs')
const editor = join(binRoot, 'editor-wrapper')
const osascript = join(binRoot, 'osascript')
const pbpaste = join(binRoot, 'pbpaste')
const pbcopy = join(binRoot, 'pbcopy')
const clipboardOutput = join(root, 'clipboard-output.txt')
const editorOutput = join(root, 'editor-output.txt')
const folderOutput = join(root, 'folder-output.txt')
const enabledDiffCapture = join(root, 'diff-enabled.raw')
const disabledDiffCapture = join(root, 'diff-disabled.raw')
const enabledRuntimeCapture = join(root, 'runtime-enabled.raw')
const restartedEnabledRuntimeCapture = join(
  root,
  'runtime-restarted-enabled.raw',
)
const disabledRuntimeCapture = join(root, 'runtime-disabled.raw')
const restartedDisabledRuntimeCapture = join(
  root,
  'runtime-restarted-disabled.raw',
)
const wlPaste = join(binRoot, 'wl-paste')
const wlCopy = join(binRoot, 'wl-copy')
const open = join(binRoot, 'open')
const xdgOpen = join(binRoot, 'xdg-open')
const snapshotHelper = join(root, 'snapshot-shared-trees.mjs')
const doctorFetchShim = join(root, 'doctor-fetch-shim.mjs')
const importedMemory = join(configRoot, 'imported.md')
const importedBefore = 'IMPORTED_TUI_CONTEXT_BEFORE'
const importedAfter = 'IMPORTED_TUI_CONTEXT_AFTER'
const providerRequests = []
let cli
let port

async function pinnedClaudeExecutable() {
  const candidates = [
    process.env.PRAXIS_CLAUDE_2_1_208,
    '/tmp/praxis-claude-pin-21208/node_modules/.bin/claude',
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, 'claude')),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      const { stdout } = await execFileAsync(candidate, ['--version'], {
        env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
        timeout: 15_000,
      })
      if (/^2\.1\.208\b/u.test(stdout.trim())) return candidate
    } catch {
      // Continue until the exact pinned executable is found.
    }
  }
  throw new Error(
    'Claude Code 2.1.208 is required; set PRAXIS_CLAUDE_2_1_208 to its executable',
  )
}

const pinnedClaude = await pinnedClaudeExecutable()
const ansiSequencePattern = new RegExp(
  String.raw`\u001B\[[0-?]*[ -/]*[@-~]`,
  'gu',
)
const ansi256ColorPattern = new RegExp(
  String.raw`\u001B\[(38|48);5;(\d+)m`,
  'u',
)
const extendedColorPattern = new RegExp(
  String.raw`\u001B\[(?:38|48);(?:2|5);`,
  'u',
)
const sgrStartPattern = new RegExp(String.raw`^\u001B\[(\d+)`, 'u')
const themeAnsiReferencePattern = new RegExp(
  String.raw`^(\u001B\[[0-9;]+m)(.*)$`,
  'su',
)

const TERMINAL_ENVIRONMENT_KEYS = [
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'NO_COLOR',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'WT_SESSION',
]
const CAPTURE_HOST_FLAG_KEYS = ['CI', 'GITHUB_ACTIONS']
const PROFILE_TERMINAL_ENVIRONMENT = {
  TERM: 'xterm-256color',
  COLORTERM: undefined,
  FORCE_COLOR: undefined,
  NO_COLOR: undefined,
  TERM_PROGRAM: undefined,
  TERM_PROGRAM_VERSION: undefined,
  WT_SESSION: undefined,
}

function normalizedTerminalEnvironment(environment, terminalEnvironment) {
  const normalized = { ...environment }
  for (const name of TERMINAL_ENVIRONMENT_KEYS) delete normalized[name]
  for (const name of CAPTURE_HOST_FLAG_KEYS) delete normalized[name]
  for (const [name, value] of Object.entries(terminalEnvironment)) {
    if (value !== undefined) normalized[name] = value
  }
  return normalized
}

function terminalEnvironmentSnapshot(environment) {
  return Object.fromEntries(
    [...TERMINAL_ENVIRONMENT_KEYS, ...CAPTURE_HOST_FLAG_KEYS].map((name) => [
      name,
      environment[name],
    ]),
  )
}

function profileTerminalEnvironment(profile) {
  return profile === 'auto'
    ? PROFILE_TERMINAL_ENVIRONMENT
    : { ...PROFILE_TERMINAL_ENVIRONMENT, COLORTERM: 'truecolor' }
}

function sgrPlane(sequence) {
  const code = Number(sgrStartPattern.exec(sequence)?.[1])
  if ((code >= 30 && code <= 39) || (code >= 90 && code <= 97))
    return 'foreground'
  if ((code >= 40 && code <= 49) || (code >= 100 && code <= 107))
    return 'background'
  return undefined
}

function activeSgrAt(output, index, plane) {
  let foreground
  let background
  const sgrPattern = new RegExp(String.raw`\u001B\[[0-9;]*m`, 'gu')
  for (const match of output.slice(0, index).matchAll(sgrPattern)) {
    const sequence = match[0]
    if (sequence === '\u001B[0m') {
      foreground = undefined
      background = undefined
      continue
    }
    const sequencePlane = sgrPlane(sequence)
    if (sequencePlane === 'foreground') {
      foreground = sequence === '\u001B[39m' ? undefined : sequence
    } else if (sequencePlane === 'background') {
      background = sequence === '\u001B[49m' ? undefined : sequence
    }
  }
  return plane === 'foreground' ? foreground : background
}

function assertThemeAnsiContext(output, ansi, token, label) {
  if (!token) {
    assert.ok(
      output.includes(ansi),
      `${label} missed exact ANSI ${JSON.stringify(ansi)}`,
    )
    return
  }
  const plane = sgrPlane(ansi)
  assert.ok(plane, `${label} used unsupported ANSI ${JSON.stringify(ansi)}`)
  let index = output.indexOf(token)
  while (index >= 0) {
    if (activeSgrAt(output, index, plane) === ansi) return
    index = output.indexOf(token, index + token.length)
  }
  assert.fail(
    `${label} did not apply ${JSON.stringify(ansi)} to ${JSON.stringify(token)}: ${JSON.stringify(output.match(new RegExp(`.{0,40}${token}.{0,40}`, 'gu')))}`,
  )
}

const LINUX_CI_ANSI_CONTEXT_FIXTURE =
  '\u001B[1G 1 \u001B[38;5;81m\u001B[1mfunction\u001B[22m\u001B[39m greet() {\u001B[K'
assert.equal(
  LINUX_CI_ANSI_CONTEXT_FIXTURE.includes('\u001B[38;5;81mfunction'),
  false,
)
assertThemeAnsiContext(
  LINUX_CI_ANSI_CONTEXT_FIXTURE,
  '\u001B[38;5;81m',
  'function',
  'Linux CI raw capture regression',
)

function assertAnsiStyled(output, payload, ansiCodes, label) {
  const text = payload.replace(/^[+-]/u, '')
  let index = output.indexOf(text)
  let styled = false
  while (index >= 0) {
    const lineStart = Math.max(
      output.lastIndexOf('\n', index),
      output.lastIndexOf('\r', index),
    )
    const prefix = output.slice(lineStart + 1, index)
    if (ansiCodes.some((ansi) => prefix.includes(ansi))) {
      styled = true
      break
    }
    index = output.indexOf(text, index + text.length)
  }
  assert.ok(
    styled,
    `${label} did not style ${JSON.stringify(payload)} with the expected ANSI: ${JSON.stringify(
      output.match(
        new RegExp(
          `.{0,100}${text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}.{0,100}`,
          'gu',
        ),
      ),
    )}; tail=${JSON.stringify(
      output.replace(ansiSequencePattern, '').slice(-4_000),
    )}`,
  )
}

function assertNotAnsiStyled(output, payload, ansiCodes, label) {
  const text = payload.replace(/^[+-]/u, '')
  let index = output.indexOf(text)
  let styled = false
  while (index >= 0) {
    const lineStart = Math.max(
      output.lastIndexOf('\n', index),
      output.lastIndexOf('\r', index),
    )
    const prefix = output.slice(lineStart + 1, index)
    if (ansiCodes.some((ansi) => prefix.includes(ansi))) {
      styled = true
      break
    }
    index = output.indexOf(text, index + text.length)
  }
  assert.ok(!styled, `${label} unexpectedly styled ${JSON.stringify(payload)}`)
}

const ANSI_256_RGB = new Map([
  [17, [0, 0, 95]],
  [22, [0, 95, 0]],
  [24, [0, 95, 135]],
  [28, [0, 135, 0]],
  [52, [95, 0, 0]],
  [81, [95, 215, 255]],
  [97, [135, 95, 175]],
  [125, [175, 0, 95]],
  [148, [175, 215, 0]],
  [153, [175, 215, 255]],
  [157, [175, 255, 175]],
  [194, [215, 255, 215]],
  [195, [215, 255, 255]],
  [224, [255, 215, 215]],
])

function praxisAnsiForClaude(reference) {
  return reference.replace(ansi256ColorPattern, (match, plane, index) => {
    const rgb = ANSI_256_RGB.get(Number(index))
    return rgb ? `\u001B[${plane};2;${rgb.join(';')}m` : match
  })
}

function shellQuote(value) {
  if (value.includes('\0')) throw new Error('Shell path must not contain NUL')
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

const packageJson = JSON.parse(
  await readFile(join(process.cwd(), 'package.json'), 'utf8'),
)
if (typeof packageJson.version !== 'string') {
  throw new Error('package.json version is missing')
}
const expectedVersionPattern = packageJson.version.replace(
  /[.*+?^${}()|[\]\\]/gu,
  '\\$&',
)

async function snapshotSharedTrees(roots) {
  const snapshot = []
  const walk = async (rootName, directory, prefix = '') => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        snapshot.push({ path: `${rootName}/${path}`, type: 'directory' })
        await walk(rootName, absolute, path)
        continue
      }
      if (entry.isSymbolicLink()) {
        snapshot.push({
          path: `${rootName}/${path}`,
          type: 'symlink',
          content: await readlink(absolute),
        })
        continue
      }
      const stats = await lstat(absolute)
      snapshot.push({
        path: `${rootName}/${path}`,
        type: stats.isFile() ? 'file' : 'other',
        content: stats.isFile()
          ? (await readFile(absolute)).toString('base64')
          : null,
      })
    }
  }
  for (const [rootName, directory] of Object.entries(roots)) {
    await walk(rootName, directory)
  }
  return snapshot
}

async function sharedTreeSnapshot() {
  return snapshotSharedTrees({
    config: configRoot,
    project: cwd,
    movedProject: movedCwd,
  })
}

function hookNavigationContract(output) {
  return [...output.matchAll(/HOOK_TRACE\|([^\r\n]+)/gu)].map(
    ([, entry]) => entry,
  )
}

const expectedHookNavigation = [
  'event:PostToolUse',
  'event:PreToolUse',
  'matcher:Local:03-local:2',
  'matcher:Project:02-project:1',
  'matcher:User:01-user:1',
  'matcher:Plugin:04-plugin:1',
  'hook:Project:prompt:Project prompt',
  'hook:Local:agent:Local agent',
  'hook:Local:command:Local command',
  'hook:User:command:User command',
  'hook:Plugin:http:https://fixture.test/plugin',
]

const hookNavigationTrace = String.raw`
set phase "hooks command palette"
send "/hooks"
expect -re {View hook configurations}
send "\r"
expect -re {6 hooks configured}
expect -re {PreToolUse[^\r\n]*\(5\)}
expect -re {PostToolUse[^\r\n]*\(1\)}
send "2"
expect -re {(❯[^\r\n]*2\. PostToolUse|Enter selection[^\r\n]*: 2)}
send "\r"
expect -re {\[User\][^\r\n]*05-user-post[^\r\n]*1 hook}
puts "HOOK_TRACE|event:PostToolUse"
send "\033"
after 200
send "1"
expect -re {(❯[^\r\n]*1\. PreToolUse|Enter selection[^\r\n]*: 1)}
send "\r"
puts "HOOK_TRACE|event:PreToolUse"
expect -re {\[Local\][^\r\n]*03-local[^\r\n]*2 hooks}
puts "HOOK_TRACE|matcher:Local:03-local:2"
expect -re {\[Project\][^\r\n]*02-project[^\r\n]*1 hook}
puts "HOOK_TRACE|matcher:Project:02-project:1"
expect -re {\[User\][^\r\n]*01-user[^\r\n]*1 hook}
puts "HOOK_TRACE|matcher:User:01-user:1"
expect -re {\[Plugin\][^\r\n]*04-plugin[^\r\n]*1 hook}
puts "HOOK_TRACE|matcher:Plugin:04-plugin:1"
send "2"
expect -re {(❯[^\r\n]*\[Project\][^\r\n]*02-project|Enter selection[^\r\n]*: 2)}
send "\r"
expect -re {\[prompt\][^\r\n]*Project prompt}
puts "HOOK_TRACE|hook:Project:prompt:Project prompt"
send "\033"
after 200
send "1"
expect -re {(❯[^\r\n]*\[Local\][^\r\n]*03-local|Enter selection[^\r\n]*: 1)}
send "\r"
expect -re {\[agent\][^\r\n]*Local agent}
puts "HOOK_TRACE|hook:Local:agent:Local agent"
expect -re {\[command\][^\r\n]*Local command}
send "2"
after 100
send "\r"
expect -re {Hook details}
expect -re {Type: command}
expect -re {Local command}
puts "HOOK_TRACE|hook:Local:command:Local command"
send "\033"
after 200
send "\033"
after 200
send "3"
expect -re {(❯[^\r\n]*\[User\][^\r\n]*01-user|Enter selection[^\r\n]*: 3)}
send "\r"
expect -re {\[command\][^\r\n]*User command}
puts "HOOK_TRACE|hook:User:command:User command"
send "\033"
after 200
send "4"
expect -re {(❯[^\r\n]*\[Plugin\][^\r\n]*04-plugin|Enter selection[^\r\n]*: 4)}
send "\r"
expect -re {\[http\][^\r\n]*https://fixture.test/plugin}
puts "HOOK_TRACE|hook:Plugin:http:https://fixture.test/plugin"
`

const provider = createServer(async (request, response) => {
  let requestBody = ''
  for await (const chunk of request) {
    // Drain request before responding so the real adapter lifecycle is tested.
    requestBody += chunk
  }
  let latestText = ''
  let payload
  try {
    payload = JSON.parse(requestBody)
    providerRequests.push(payload)
    const latestContent = payload.messages?.at(-1)?.content
    latestText =
      typeof latestContent === 'string'
        ? latestContent
        : JSON.stringify(latestContent ?? '')
  } catch {
    // Invalid provider requests are exercised by the adapter tests.
  }
  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  const latestUserIndex = messages.findLastIndex(
    (message) => message?.role === 'user',
  )
  const latestUserText = JSON.stringify(
    messages[latestUserIndex]?.content ?? '',
  )
  const toolResultCount = messages
    .slice(latestUserIndex + 1)
    .filter((message) => message?.role === 'tool').length
  const surfaceMode = latestUserText.includes('reply briefly')
    ? 'ENABLED'
    : latestUserText.includes('disabled surface probe')
      ? 'DISABLED'
      : null
  if (surfaceMode && toolResultCount < 2) {
    const toolCall =
      toolResultCount === 0
        ? {
            index: 0,
            id: `call_${surfaceMode.toLowerCase()}_tool_diff`,
            type: 'function',
            function: {
              name: 'Bash',
              arguments: JSON.stringify({
                command: `printf '@@ ${surfaceMode}_TOOL_RESULT\\n-${surfaceMode}_TOOL_OLD\\n+${surfaceMode}_TOOL_NEW\\n'`,
              }),
            },
          }
        : {
            index: 0,
            id: `call_${surfaceMode.toLowerCase()}_edit`,
            type: 'function',
            function: {
              name: 'Edit',
              arguments: JSON.stringify({
                file_path: join(
                  surfaceMode === 'ENABLED' ? cwd : movedCwd,
                  'edit-fixture.txt',
                ),
                old_string:
                  surfaceMode === 'ENABLED'
                    ? 'EDIT_ENABLED_OLD'
                    : 'EDIT_DISABLED_OLD',
                new_string:
                  surfaceMode === 'ENABLED'
                    ? 'EDIT_ENABLED_NEW'
                    : 'EDIT_DISABLED_NEW',
              }),
            },
          }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [toolCall] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
    )
    return
  }
  const content = latestText.includes('Reply with SIDE only.')
    ? 'SIDE'
    : surfaceMode === 'ENABLED'
      ? 'TUI_MODEL_OK\n\n```ts\nfunction runtimeEnabledSentinel() { return "enabled-runtime-string" }\n```'
      : surfaceMode === 'DISABLED'
        ? 'TUI_DISABLED_OK\n\n```ts\nfunction runtimeDisabledSentinel() { return "disabled-runtime-string" }\n```'
        : latestText.includes('memory reload probe')
          ? 'MEMORY_RELOAD_OK'
          : 'TUI_FAKE_OK\n\n```ts\nfunction defaultRuntimeSentinel() { return "default-runtime-string" }\n```'
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
  )
})

try {
  await access(claude)
  const { stdout: claudeVersion } = await execFileAsync(claude, ['--version'])
  assert.match(claudeVersion, /^2\.1\.208\b/u)
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(join(configRoot, 'plans'), { recursive: true }),
    mkdir(join(configRoot, 'commands'), { recursive: true }),
    mkdir(join(configRoot, 'agents'), { recursive: true }),
    mkdir(cwd, { recursive: true }),
    mkdir(movedCwd, { recursive: true }),
    mkdir(sharedRoot),
    mkdir(installRoot),
    mkdir(binRoot),
    mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true }),
    mkdir(join(pluginRoot, 'hooks'), { recursive: true }),
    mkdir(join(cwd, '.claude'), { recursive: true }),
    mkdir(join(movedCwd, '.claude'), { recursive: true }),
  ])
  const canonicalCwd = await realpath(cwd)

  const claudeThemeAnsi = {
    auto: [
      '\u001B[38;5;81mfunction',
      '\u001B[38;5;148mgreet',
      '\u001B[48;5;52m',
      '\u001B[48;5;22m',
      '\u001B[48;5;28mClaude',
    ],
    dark: [
      '\u001B[38;5;81mfunction',
      '\u001B[38;5;148mgreet',
      '\u001B[48;5;52m',
      '\u001B[48;5;22m',
      '\u001B[48;5;28mClaude',
    ],
    light: [
      '\u001B[38;5;125mfunction',
      '\u001B[38;5;97mgreet',
      '\u001B[48;5;224m',
      '\u001B[48;5;194m',
      '\u001B[48;5;157mClaude',
    ],
    'dark-daltonized': [
      '\u001B[38;5;81mfunction',
      '\u001B[38;5;148mgreet',
      '\u001B[48;5;52m',
      '\u001B[48;5;17m',
      '\u001B[48;5;24mClaude',
    ],
    'light-daltonized': [
      '\u001B[38;5;125mfunction',
      '\u001B[38;5;97mgreet',
      '\u001B[48;5;224m',
      '\u001B[48;5;195m',
      '\u001B[48;5;153mClaude',
    ],
    'dark-ansi': [
      '\u001B[96mfunction',
      '\u001B[93mgreet',
      '\u001B[37m',
      '\u001B[92m',
    ],
    'light-ansi': [
      '\u001B[96mfunction',
      '\u001B[93mgreet',
      '\u001B[30m',
      '\u001B[92m',
    ],
  }
  const realClaudeThemeCaptures = new Map()
  const realClaudeThemeEnvironments = new Map()
  const cleanAutoProfileEnvironment = normalizedTerminalEnvironment(
    process.env,
    PROFILE_TERMINAL_ENVIRONMENT,
  )
  const contaminatedProfileEnvironment = normalizedTerminalEnvironment(
    {
      ...process.env,
      TERM: 'xterm-direct',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '3',
      NO_COLOR: '1',
      TERM_PROGRAM: 'iTerm.app',
      CI: 'true',
      GITHUB_ACTIONS: 'true',
    },
    PROFILE_TERMINAL_ENVIRONMENT,
  )
  assert.deepEqual(
    terminalEnvironmentSnapshot(contaminatedProfileEnvironment),
    terminalEnvironmentSnapshot(cleanAutoProfileEnvironment),
    'profile terminal normalization leaked host truecolor signals',
  )
  for (const name of ['CI', 'GITHUB_ACTIONS', 'NO_COLOR', 'FORCE_COLOR']) {
    assert.equal(
      contaminatedProfileEnvironment[name],
      undefined,
      `profile terminal normalization retained ${name}`,
    )
  }
  const realClaudeRoot = join(root, 'real-claude')
  const realClaudeCwd = join(realClaudeRoot, 'work')
  const realClaudeTmuxSocket = join(realClaudeRoot, 'tmux.sock')
  await mkdir(realClaudeCwd, { recursive: true })
  const canonicalRealClaudeCwd = await realpath(realClaudeCwd)
  async function waitForRealClaudeScreen(session, pattern, stage) {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      try {
        const { stdout } = await execFileAsync(
          'tmux',
          ['-S', realClaudeTmuxSocket, 'capture-pane', '-p', '-t', session],
          { maxBuffer: 1024 * 1024 },
        )
        if (pattern.test(stdout)) return
      } catch {
        throw new Error(`Claude 2.1.208 ${session} exited during ${stage}`)
      }
      await delay(100)
    }
    throw new Error(`Claude 2.1.208 ${session} timed out during ${stage}`)
  }
  for (const [profile, expectedAnsi] of Object.entries(claudeThemeAnsi)) {
    const terminalEnvironment = profileTerminalEnvironment(profile)
    const claudeProfileEnvironment = normalizedTerminalEnvironment(
      process.env,
      terminalEnvironment,
    )
    const claudeTerminalArguments = ['env']
    for (const [name, value] of Object.entries(terminalEnvironment)) {
      if (value === undefined) claudeTerminalArguments.push('-u', name)
    }
    for (const [name, value] of Object.entries(terminalEnvironment)) {
      if (value !== undefined) claudeTerminalArguments.push(`${name}=${value}`)
    }
    realClaudeThemeEnvironments.set(profile, claudeProfileEnvironment)
    const profileConfig = join(realClaudeRoot, profile)
    await mkdir(profileConfig, { recursive: true })
    await writeFile(
      join(profileConfig, '.claude.json'),
      `${JSON.stringify({
        hasCompletedOnboarding: true,
        installMethod: 'global',
        autoUpdates: false,
        hasSeenTasksHint: true,
        projects: {
          [canonicalRealClaudeCwd]: {
            allowedTools: [],
            disabledMcpjsonServers: [],
            enabledMcpjsonServers: [],
            hasClaudeMdExternalIncludesApproved: false,
            hasClaudeMdExternalIncludesWarningShown: false,
            hasTrustDialogAccepted: true,
            mcpContextUris: [],
            mcpServers: {},
            projectOnboardingSeenCount: 1,
          },
        },
      })}\n`,
    )
    await writeFile(
      join(profileConfig, 'settings.json'),
      `${JSON.stringify({ theme: profile })}\n`,
    )
    const capturePath = join(profileConfig, 'capture.raw')
    const session = `claude-${profile}`
    await execFileAsync(
      'tmux',
      [
        '-f',
        '/dev/null',
        '-S',
        realClaudeTmuxSocket,
        'new-session',
        '-d',
        '-s',
        session,
        '-x',
        '100',
        '-y',
        '32',
        '-c',
        canonicalRealClaudeCwd,
        '-e',
        'DISABLE_AUTOUPDATER=1',
        '-e',
        `CLAUDE_CONFIG_DIR=${profileConfig}`,
        ...claudeTerminalArguments,
        pinnedClaude,
      ],
      { env: claudeProfileEnvironment, timeout: 15_000 },
    )
    try {
      await execFileAsync('tmux', [
        '-S',
        realClaudeTmuxSocket,
        'pipe-pane',
        '-O',
        '-t',
        session,
        `cat > ${shellQuote(capturePath)}`,
      ])
      await waitForRealClaudeScreen(
        session,
        /Claude Code v2\.1\.208/u,
        'startup',
      )
      await execFileAsync('tmux', [
        '-S',
        realClaudeTmuxSocket,
        'send-keys',
        '-t',
        session,
        '-l',
        '/theme',
      ])
      await execFileAsync('tmux', [
        '-S',
        realClaudeTmuxSocket,
        'send-keys',
        '-t',
        session,
        'Enter',
      ])
      await waitForRealClaudeScreen(
        session,
        /Choose the text style that looks best with your terminal/u,
        'theme preview',
      )
      await delay(250)
    } finally {
      await execFileAsync(
        'tmux',
        ['-S', realClaudeTmuxSocket, 'kill-session', '-t', session],
        { timeout: 5_000 },
      ).catch(() => {})
    }
    const stdout = await readFile(capturePath, 'utf8')
    realClaudeThemeCaptures.set(profile, stdout)
    for (const ansi of expectedAnsi) {
      assert.ok(
        stdout.includes(ansi),
        `Claude 2.1.208 ${profile} preview missed ${JSON.stringify(ansi)}`,
      )
    }
    console.log(`Claude 2.1.208 ${profile} ANSI profile passed`)
  }
  await writeFile(
    join(configRoot, 'commands', 'review.md'),
    '---\ndescription: Review the shared fixture.\n---\nReview $ARGUMENTS\n',
  )
  await writeFile(
    join(configRoot, 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviews the shared fixture.\n---\nReview the requested fixture.\n',
  )
  await writeFile(
    join(configRoot, 'CLAUDE.md'),
    '# Shared user memory\n@imported.md\n',
  )
  await writeFile(importedMemory, `${importedBefore}\n`)
  await writeFile(join(cwd, 'CLAUDE.md'), '# Shared project memory\n')
  await writeFile(
    join(configRoot, 'settings.json'),
    `${JSON.stringify(
      {
        theme: 'dark',
        autoUpdatesChannel: 'latest',
        permissions: { allow: ['Bash(npm test:*)'] },
        enabledPlugins: { 'hooks-fixture@inline': true },
        hooks: {
          PreToolUse: [
            {
              matcher: '01-user',
              hooks: [
                {
                  type: 'command',
                  command: 'printf fixture-hook',
                  statusMessage: 'User command',
                },
              ],
            },
          ],
          PostToolUse: [
            {
              matcher: '05-user-post',
              hooks: [{ type: 'command', command: 'printf post-hook' }],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  )
  await Promise.all([
    writeFile(
      join(configRoot, '.claude.json'),
      `${JSON.stringify(
        {
          hasCompletedOnboarding: true,
          projects: {
            [canonicalCwd]: {
              allowedTools: [],
              mcpContextUris: [],
              mcpServers: {},
              enabledMcpjsonServers: [],
              disabledMcpjsonServers: [],
              hasTrustDialogAccepted: true,
              projectOnboardingSeenCount: 1,
              hasClaudeMdExternalIncludesApproved: false,
              hasClaudeMdExternalIncludesWarningShown: false,
              lastGracefulShutdown: true,
              lastVersionBase: '2.1.208',
            },
          },
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      join(cwd, '.claude', 'settings.json'),
      `${JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: '02-project',
              hooks: [{ type: 'prompt', prompt: 'Project prompt' }],
            },
          ],
        },
      })}\n`,
    ),
    writeFile(
      join(cwd, '.claude', 'settings.local.json'),
      `${JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: '03-local',
              hooks: [
                { type: 'agent', prompt: 'Local agent' },
                { type: 'command', command: 'Local command' },
              ],
            },
          ],
        },
      })}\n`,
    ),
    writeFile(
      join(movedCwd, '.claude', 'settings.json'),
      `${JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: '02-project',
              hooks: [{ type: 'prompt', prompt: 'Moved project prompt' }],
            },
          ],
        },
      })}\n`,
    ),
    writeFile(
      join(movedCwd, '.claude', 'settings.local.json'),
      `${JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: '03-local',
              hooks: [
                { type: 'agent', prompt: 'Moved local agent' },
                { type: 'command', command: 'Moved local command' },
              ],
            },
          ],
        },
      })}\n`,
    ),
    writeFile(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      `${JSON.stringify({
        name: 'hooks-fixture',
        version: '1.0.0',
        hooks: './hooks/hooks.json',
      })}\n`,
    ),
    writeFile(
      pluginHooks,
      `${JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: '04-plugin',
              hooks: [{ type: 'http', url: 'https://fixture.test/plugin' }],
            },
          ],
        },
      })}\n`,
    ),
    writeFile(
      join(configRoot, 'plugins', 'installed_plugins.json'),
      `${JSON.stringify({
        version: 2,
        plugins: {
          'hooks-fixture@inline': [
            {
              scope: 'user',
              installPath: pluginRoot,
              version: '1.0.0',
              installedAt: '2026-08-11T00:00:00.000Z',
              lastUpdated: '2026-08-11T00:00:00.000Z',
            },
          ],
        },
      })}\n`,
    ),
    writeFile(
      pluginReloader,
      `import { writeFile } from 'node:fs/promises'\nconst path = process.argv[2]\nawait writeFile(path, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '04-plugin', hooks: [{ type: 'http', url: 'https://fixture.test/plugin-reloaded' }] }] } }) + '\\n')\n`,
    ),
  ])
  for (const workRoot of [cwd, movedCwd]) {
    const diffFixture = join(workRoot, 'fixture.txt')
    const diffPhase = workRoot === cwd ? 'ENABLED' : 'RESTART_ENABLED'
    await writeFile(diffFixture, `DIFF_${diffPhase}_BEFORE\n`)
    await writeFile(join(workRoot, '.gitignore'), 'edit-fixture.txt\n')
    await execFileAsync('git', ['init', '-q'], { cwd: workRoot })
    await execFileAsync('git', ['add', 'fixture.txt', '.gitignore'], {
      cwd: workRoot,
    })
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=Praxis Fixture',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-qm',
        'fixture',
      ],
      { cwd: workRoot },
    )
    await writeFile(diffFixture, `DIFF_${diffPhase}_AFTER\n`)
  }
  await Promise.all([
    writeFile(join(cwd, 'edit-fixture.txt'), 'EDIT_ENABLED_OLD\n'),
    writeFile(join(movedCwd, 'edit-fixture.txt'), 'EDIT_DISABLED_OLD\n'),
  ])
  await writeFile(
    editor,
    `#!/bin/sh
case "$1" in
  *keybindings.json) exit 0 ;;
  *imported.md)
    printf '${importedAfter}\\n' > "$1"
    printf '%s\\n' "$1" >> "$TUI_EDITOR_OUTPUT"
    exit 0
    ;;
esac
printf 'edited first line\\nedited second line\\n\\n' > "$1"
`,
  )
  await chmod(editor, 0o755)
  await writeFile(osascript, '#!/bin/sh\nexit 1\n')
  await writeFile(pbpaste, "#!/bin/sh\nprintf 'INSTALLED_CLIPBOARD'\n")
  await writeFile(pbcopy, '#!/bin/sh\ncat > "$TUI_CLIPBOARD_OUTPUT"\n')
  await writeFile(wlCopy, '#!/bin/sh\ncat > "$TUI_CLIPBOARD_OUTPUT"\n')
  const folderLauncher =
    '#!/bin/sh\nprintf \'%s\\n\' "$1" > "$TUI_FOLDER_OUTPUT"\n'
  await Promise.all([
    writeFile(open, folderLauncher),
    writeFile(xdgOpen, folderLauncher),
    writeFile(
      snapshotHelper,
      `import { lstat, readFile, readdir, readlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

${snapshotSharedTrees.toString()}

const snapshot = await snapshotSharedTrees({
  config: process.argv[2],
  project: process.argv[3],
})
await writeFile(process.argv[4], JSON.stringify(snapshot))
`,
    ),
  ])
  await writeFile(
    wlPaste,
    '#!/bin/sh\ncase "$*" in *image/png*) exit 1 ;; *) printf \'INSTALLED_CLIPBOARD\' ;; esac\n',
  )
  await writeFile(
    doctorFetchShim,
    `const registryUrl = 'https://registry.npmjs.org/-/package/praxis-agent/dist-tags'
const originalFetch = globalThis.fetch

globalThis.fetch = async (...args) => {
  const [input] = args
  const url =
    typeof input === 'string' || input instanceof URL ? String(input) : input.url
  if (url !== registryUrl) return originalFetch(...args)
  await new Promise((resolve) => setTimeout(resolve, 2750))
  return new Response(JSON.stringify({ stable: '91.2.3', latest: '91.2.4' }), {
    headers: { 'content-type': 'application/json' },
  })
}
`,
  )
  await Promise.all([
    chmod(osascript, 0o755),
    chmod(pbpaste, 0o755),
    chmod(pbcopy, 0o755),
    chmod(wlCopy, 0o755),
    chmod(wlPaste, 0o755),
    chmod(open, 0o755),
    chmod(xdgOpen, 0o755),
  ])
  const { stdout: packed } = await execFileAsync(
    'npm',
    ['pack', '--pack-destination', root],
    { cwd: process.cwd(), timeout: 60_000 },
  )
  const artifact = join(root, packed.trim().split(/\s+/u).at(-1))
  await execFileAsync(
    'npm',
    ['install', '--prefix', installRoot, '--ignore-scripts', artifact],
    { timeout: 60_000 },
  )
  cli = join(installRoot, 'node_modules', 'praxis-agent', 'dist', 'cli.js')
  await new Promise((resolve, reject) => {
    provider.once('error', reject)
    provider.listen(0, '127.0.0.1', resolve)
  })
  port = provider.address().port
  const tuiProbeEnvironment = {
    ...process.env,
    FORCE_COLOR: '3',
    PRAXIS_CLAUDE_BINARY: pinnedClaude,
  }
  delete tuiProbeEnvironment.NO_COLOR

  for (const [profile, expectedAnsi] of Object.entries(claudeThemeAnsi)) {
    const praxisProfileEnvironment = normalizedTerminalEnvironment(
      process.env,
      profileTerminalEnvironment(profile),
    )
    const claudeProfileEnvironment = realClaudeThemeEnvironments.get(profile)
    assert.ok(
      claudeProfileEnvironment,
      `missing Claude ${profile} terminal environment`,
    )
    assert.deepEqual(
      terminalEnvironmentSnapshot(praxisProfileEnvironment),
      terminalEnvironmentSnapshot(claudeProfileEnvironment),
      `Claude and Praxis ${profile} terminal environments diverged`,
    )
    const profileConfig = join(root, 'praxis-themes', profile)
    await mkdir(profileConfig, { recursive: true })
    await writeFile(
      join(profileConfig, 'settings.json'),
      `${JSON.stringify({ theme: profile })}\n`,
    )
    const profileProbe = String.raw`
set timeout 15
log_user 1
log_file -noappend $env(TUI_CAPTURE_FILE)
spawn -noecho env COLUMNS=100 LINES=32 CLAUDE_CONFIG_DIR=$env(TUI_PROFILE_CONFIG) PRAXIS_PROVIDER=openai PRAXIS_API_KEY=fixture-key PRAXIS_MODEL=fixture-model PRAXIS_BASE_URL=$env(TUI_PROVIDER_URL) $env(TUI_NODE) $env(TUI_CLI) --dangerously-skip-permissions
stty rows 32 columns 100 < $spawn_out(slave,name)
expect -re {Praxis.*Code.*v${expectedVersionPattern}}
expect -re {Try.*review this project}
send "/theme"
expect -re {Change the theme}
send "\r"
expect -re {Choose the text style that looks best with your terminal}
expect -re {function}
after 200
send "\033"
after 100
send "\003"
expect -re {Press Ctrl-C again to exit}
send "\003"
expect eof
exit 0
`
    const profileCapture = join(root, `praxis-theme-${profile}.ansi`)
    await execFileAsync('expect', ['-c', profileProbe], {
      cwd,
      env: {
        ...praxisProfileEnvironment,
        TUI_CLI: cli,
        TUI_NODE: process.execPath,
        TUI_CAPTURE_FILE: profileCapture,
        TUI_PROFILE_CONFIG: profileConfig,
        TUI_PROVIDER_URL: `http://127.0.0.1:${port}/v1`,
      },
      timeout: 90_000,
    })
    const praxisOutput = await readFile(profileCapture, 'utf8')
    const claudeOutput = realClaudeThemeCaptures.get(profile)
    assert.ok(claudeOutput, `missing Claude ${profile} reference capture`)
    for (const reference of expectedAnsi) {
      const referenceMatch = themeAnsiReferencePattern.exec(reference)
      assert.ok(referenceMatch, `invalid theme ANSI reference ${reference}`)
      const claudeAnsi = referenceMatch[1]
      const claudeToken = referenceMatch[2]
      const praxisAnsi =
        profile === 'auto' ? claudeAnsi : praxisAnsiForClaude(claudeAnsi)
      const praxisToken = claudeToken
      assertThemeAnsiContext(
        claudeOutput,
        claudeAnsi,
        claudeToken,
        `Claude 2.1.208 ${profile}`,
      )
      assertThemeAnsiContext(
        praxisOutput,
        praxisAnsi,
        praxisToken,
        `Praxis ${profile}`,
      )
    }
    console.log(`Praxis ${profile} ANSI matched Claude 2.1.208`)
  }

  const linuxLikeAutoEnvironment = normalizedTerminalEnvironment(
    process.env,
    PROFILE_TERMINAL_ENVIRONMENT,
  )
  const linuxLikeAutoProbe = String.raw`
set timeout 15
log_user 1
spawn -noecho env COLUMNS=100 LINES=32 TERM=xterm-256color CLAUDE_CONFIG_DIR=$env(TUI_PROFILE_CONFIG) PRAXIS_PROVIDER=openai PRAXIS_API_KEY=fixture-key PRAXIS_MODEL=fixture-model PRAXIS_BASE_URL=$env(TUI_PROVIDER_URL) $env(TUI_NODE) $env(TUI_CLI) --dangerously-skip-permissions
stty rows 32 columns 100 < $spawn_out(slave,name)
expect -re {Praxis.*Code.*v${expectedVersionPattern}}
expect -re {Try.*review this project}
send "/theme"
expect -re {Change the theme}
send "\r"
expect -re {Choose the text style that looks best with your terminal}
after 200
send "\033"
after 100
send "\003"
expect -re {Press Ctrl-C again to exit}
send "\003"
expect eof
exit 0
`
  const { stdout: linuxLikeAutoOutput } = await execFileAsync(
    'expect',
    ['-c', linuxLikeAutoProbe],
    {
      cwd,
      env: {
        ...linuxLikeAutoEnvironment,
        TERM: 'xterm-256color',
        TUI_CLI: cli,
        TUI_NODE: process.execPath,
        TUI_PROFILE_CONFIG: join(root, 'praxis-themes', 'auto'),
        TUI_PROVIDER_URL: `http://127.0.0.1:${port}/v1`,
      },
      timeout: 60_000,
    },
  )
  for (const reference of claudeThemeAnsi.auto) {
    const exactAnsi = reference.endsWith('Claude')
      ? reference.slice(0, -'Claude'.length)
      : reference
    assert.ok(
      linuxLikeAutoOutput.includes(exactAnsi),
      `Praxis auto Linux-like 256-color output missed exact Claude ANSI ${JSON.stringify(exactAnsi)}`,
    )
  }
  assert.ok(linuxLikeAutoOutput.includes('Claude'))
  assert.ok(
    !linuxLikeAutoOutput.includes('\u001B[38;2;95;215;255mfunction'),
    'Praxis auto Linux-like 256-color output emitted truecolor syntax',
  )
  console.log('Praxis auto Linux-like 256-color ANSI matched Claude 2.1.208')

  const linuxLikeTruecolorEnvironment = normalizedTerminalEnvironment(
    process.env,
    { ...PROFILE_TERMINAL_ENVIRONMENT, COLORTERM: 'truecolor' },
  )
  const { stdout: linuxLikeTruecolorOutput } = await execFileAsync(
    'expect',
    ['-c', linuxLikeAutoProbe],
    {
      cwd,
      env: {
        ...linuxLikeTruecolorEnvironment,
        TUI_CLI: cli,
        TUI_NODE: process.execPath,
        TUI_PROFILE_CONFIG: join(root, 'praxis-themes', 'auto'),
        TUI_PROVIDER_URL: `http://127.0.0.1:${port}/v1`,
      },
      timeout: 60_000,
    },
  )
  for (const exactAnsi of [
    '\u001B[38;2;95;215;255mfunction',
    '\u001B[38;2;175;215;0mgreet',
    '\u001B[48;2;95;0;0m',
    '\u001B[48;2;0;95;0m',
    '\u001B[48;2;0;135;0m',
  ]) {
    assert.ok(
      linuxLikeTruecolorOutput.includes(exactAnsi),
      `Praxis auto Linux-like truecolor output missed exact ANSI ${JSON.stringify(exactAnsi)}`,
    )
  }
  console.log('Praxis auto Linux-like truecolor output used exact RGB colors')

  const linuxLikeAnsi16Probe = String.raw`
set timeout 15
log_user 1
spawn -noecho env COLUMNS=100 LINES=32 TERM=xterm CLAUDE_CONFIG_DIR=$env(TUI_PROFILE_CONFIG) PRAXIS_PROVIDER=openai PRAXIS_API_KEY=fixture-key PRAXIS_MODEL=fixture-model PRAXIS_BASE_URL=$env(TUI_PROVIDER_URL) $env(TUI_NODE) $env(TUI_CLI) --dangerously-skip-permissions
stty rows 32 columns 100 < $spawn_out(slave,name)
expect -re {Praxis.*Code.*v${expectedVersionPattern}}
expect -re {Try.*review this project}
send "/theme"
expect -re {Change the theme}
send "\r"
expect -re {Choose the text style that looks best with your terminal}
after 200
send "\033"
after 100
send "\003"
expect -re {Press Ctrl-C again to exit}
send "\003"
expect eof
exit 0
`
  const { stdout: linuxLikeAnsi16Output } = await execFileAsync(
    'expect',
    ['-c', linuxLikeAnsi16Probe],
    {
      cwd,
      env: {
        ...linuxLikeAutoEnvironment,
        TERM: 'xterm',
        TUI_CLI: cli,
        TUI_NODE: process.execPath,
        TUI_PROFILE_CONFIG: join(root, 'praxis-themes', 'auto'),
        TUI_PROVIDER_URL: `http://127.0.0.1:${port}/v1`,
      },
      timeout: 60_000,
    },
  )
  for (const exactAnsi of [
    '\u001B[96mfunction',
    '\u001B[93mgreet',
    '\u001B[40m',
  ]) {
    assert.ok(
      linuxLikeAnsi16Output.includes(exactAnsi),
      `Praxis auto Linux-like ANSI-16 output missed exact ANSI ${JSON.stringify(exactAnsi)}`,
    )
  }
  assertAnsiStyled(
    linuxLikeAnsi16Output,
    'Claude',
    ['\u001B[42m'],
    'Praxis auto Linux-like ANSI-16 added highlight',
  )
  assert.doesNotMatch(
    linuxLikeAnsi16Output,
    extendedColorPattern,
    'Praxis auto Linux-like ANSI-16 output emitted an extended color',
  )
  console.log('Praxis auto Linux-like ANSI-16 output used only basic colors')

  const cancelConfigRoot = join(root, 'cancel-config')
  const cancelCwd = join(root, 'cancel-work')
  const cancelSessionId = randomUUID()
  await Promise.all([
    mkdir(join(cancelConfigRoot, 'rules', 'nested'), { recursive: true }),
    mkdir(join(cancelCwd, '.claude', 'rules'), { recursive: true }),
  ])
  const cancelMemoryDirectory = await resolveClaudeProjectMemoryDirectory({
    configRoot: cancelConfigRoot,
    cwd: cancelCwd,
  })
  const cancelProjectDirectory = dirname(cancelMemoryDirectory)
  const cancelSentinel = join(cancelProjectDirectory, 'snapshot-sentinel.jsonl')
  await mkdir(cancelProjectDirectory, { recursive: true })
  await Promise.all([
    writeFile(
      join(cancelConfigRoot, 'CLAUDE.md'),
      '# Cancel user memory\n@details/imported.md\n',
    ),
    writeFile(
      join(cancelConfigRoot, 'rules', 'nested', 'rule.md'),
      '# Cancel nested user rule\n',
    ),
    mkdir(join(cancelConfigRoot, 'details'), { recursive: true }).then(() =>
      writeFile(
        join(cancelConfigRoot, 'details', 'imported.md'),
        'CANCEL_IMPORTED_UNCHANGED\n',
      ),
    ),
    writeFile(join(cancelCwd, 'CLAUDE.md'), '# Cancel project memory\n'),
    writeFile(
      join(cancelCwd, '.claude', 'rules', 'project.md'),
      '# Cancel nested project rule\n',
    ),
    writeFile(cancelSentinel, '{"sentinel":"unchanged"}\n'),
  ])
  const sentinelBefore = await snapshotSharedTrees({
    config: cancelConfigRoot,
    project: cancelCwd,
  })
  await writeFile(cancelSentinel, '{"sentinel":"mutated"}\n')
  const sentinelMutated = await snapshotSharedTrees({
    config: cancelConfigRoot,
    project: cancelCwd,
  })
  const sentinelBeforeRecord = sentinelBefore.find(({ path }) =>
    path.endsWith('/snapshot-sentinel.jsonl'),
  )
  const sentinelMutatedRecord = sentinelMutated.find(({ path }) =>
    path.endsWith('/snapshot-sentinel.jsonl'),
  )
  assert.ok(sentinelBeforeRecord)
  assert.ok(sentinelMutatedRecord)
  const sentinelRecordPath = sentinelBeforeRecord.path
  assert.notDeepEqual(
    sentinelMutatedRecord,
    sentinelBeforeRecord,
    'shared-tree snapshot did not detect a sibling JSONL mutation',
  )
  await writeFile(cancelSentinel, '{"sentinel":"unchanged"}\n')
  const cancelBeforePath = join(root, 'cancel-before.json')
  const cancelAfterPath = join(root, 'cancel-after.json')
  const cancelProbe = String.raw`
set timeout 15
log_user 1
set phase "installed memory cancel"
proc write_shared_snapshot {label output} {
  global env phase
  set phase "installed memory cancel $label snapshot"
  set command [list $env(TUI_NODE) $env(TUI_SNAPSHOT_HELPER) $env(TUI_CANCEL_CONFIG_ROOT) $env(TUI_CANCEL_CWD) $output]
  if {[catch {exec -- {*}$command 2>@1} result]} {
    puts stderr "TUI $label snapshot producer failed: $result"
    exit 1
  }
  if {![file isfile $output] || [file size $output] == 0} {
    puts stderr "TUI $label snapshot producer did not create a non-empty artifact at $output"
    exit 1
  }
  puts "TUI_SNAPSHOT_READY|$label"
}
expect_before timeout {
  puts stderr "TUI memory cancel timed out during $phase"
  exit 1
}
spawn -noecho env COLUMNS=100 LINES=32 TERM=xterm-256color PATH=$env(PATH) CLAUDE_CONFIG_DIR=$env(TUI_CANCEL_CONFIG_ROOT) PRAXIS_PROVIDER=openai PRAXIS_API_KEY=fixture-key PRAXIS_MODEL=fixture-model PRAXIS_BASE_URL=$env(TUI_PROVIDER_URL) $env(TUI_NODE) $env(TUI_CLI) --session-id $env(TUI_CANCEL_SESSION_ID) --dangerously-skip-permissions
stty rows 32 columns 100 < $spawn_out(slave,name)
expect -re {Praxis.*Code.*v${expectedVersionPattern}}
write_shared_snapshot before $env(TUI_CANCEL_BEFORE)
send "/memory"
expect -re {Open a memory file in your editor}
send "\r"
expect -re {Auto-memory: on}
expect -re {User memory}
expect -re {imported.md}
expect -re {Project memory}
expect -re {Open auto-memory folder}
send "\033"
expect -re {Cancelled memory editing}
write_shared_snapshot after $env(TUI_CANCEL_AFTER)
send "\003"
expect -re {Press Ctrl-C again to exit}
send "\003"
expect eof
exit 0
`
  const cancelCapture = await execFileAsync('expect', ['-c', cancelProbe], {
    cwd: cancelCwd,
    env: {
      ...process.env,
      CI: 'true',
      PATH: `${binRoot}${delimiter}${dirname(claude)}${delimiter}${process.env.PATH ?? ''}`,
      TUI_CANCEL_AFTER: cancelAfterPath,
      TUI_CANCEL_BEFORE: cancelBeforePath,
      TUI_CANCEL_CONFIG_ROOT: cancelConfigRoot,
      TUI_CANCEL_CWD: cancelCwd,
      TUI_CANCEL_SESSION_ID: cancelSessionId,
      TUI_CLI: cli,
      TUI_NODE: process.execPath,
      TUI_PROVIDER_URL: `http://127.0.0.1:${port}/v1`,
      TUI_SNAPSHOT_HELPER: snapshotHelper,
    },
    timeout: 60_000,
  })
  assert.deepEqual(
    [...cancelCapture.stdout.matchAll(/TUI_SNAPSHOT_READY\|([^\r\n]+)/gu)].map(
      ([, label]) => label,
    ),
    ['before', 'after'],
    `memory cancel snapshot producers did not complete in order:\n${cancelCapture.stdout}\n${cancelCapture.stderr}`,
  )
  const [cancelBefore, cancelAfter] = await Promise.all(
    [cancelBeforePath, cancelAfterPath].map(async (path) => {
      await access(path)
      const snapshot = JSON.parse(await readFile(path, 'utf8'))
      assert.ok(Array.isArray(snapshot), `${path} did not contain a snapshot`)
      return snapshot
    }),
  )
  const cancelProjectPrefix = sentinelRecordPath.slice(
    0,
    -'snapshot-sentinel.jsonl'.length,
  )
  const sessionTranscriptPath = `${cancelProjectPrefix}${cancelSessionId}.jsonl`
  const runtimeArtifacts = new Set([
    'config/history.jsonl',
    sessionTranscriptPath,
    `${sessionTranscriptPath}.lock`,
  ])
  const sharedSnapshot = (snapshot) =>
    snapshot.filter(({ path }) => !runtimeArtifacts.has(path))
  assert.ok(
    cancelAfter.some(({ path }) => path === sentinelRecordPath),
    'sibling JSONL sentinel was not covered by the cancel snapshot',
  )
  assert.deepEqual(
    sharedSnapshot(cancelAfter),
    sharedSnapshot(cancelBefore),
    'installed /memory cancel changed the recursive shared tree',
  )
  const claudeHooksProbe = String.raw`
set timeout 20
log_user 1
set phase "Claude 2.1.208 startup"
expect_before timeout {
  puts stderr "Claude hooks capture timed out during $phase"
  exit 1
}
spawn -noecho env COLUMNS=100 LINES=32 TERM=xterm-256color DISABLE_AUTOUPDATER=1 CLAUDE_CONFIG_DIR=$env(TUI_CONFIG_ROOT) $env(TUI_CLAUDE) --ax-screen-reader --plugin-dir $env(TUI_PLUGIN_ROOT)
stty rows 32 columns 100 < $spawn_out(slave,name)
expect {
  -re {Quick.*safety.*check} { send "\r"; exp_continue }
  -re {manual mode on} {}
  eof { puts stderr "Claude exited before startup"; exit 1 }
}
set phase "Claude hooks menu"
after 300
${hookNavigationTrace}
catch {exec kill -KILL [exp_pid]}
close
catch {wait}
exit 0
`
  const claudeHooksCapture = await execFileAsync(
    'expect',
    ['-c', claudeHooksProbe],
    {
      cwd,
      env: {
        ...process.env,
        PATH: `${dirname(claude)}${delimiter}${process.env.PATH ?? ''}`,
        TUI_CLAUDE: claude,
        TUI_CONFIG_ROOT: configRoot,
        TUI_PLUGIN_ROOT: pluginRoot,
      },
      timeout: 90_000,
    },
  )
  const observedClaudeContract = hookNavigationContract(
    claudeHooksCapture.stdout,
  )
  assert.deepEqual(observedClaudeContract, expectedHookNavigation)

  const providerlessProbe = String.raw`
set timeout 60
log_user 1
set phase "providerless startup"
expect_before timeout {
  puts stderr "Providerless hooks probe timed out during $phase"
  exit 1
}
spawn -noecho env COLUMNS=100 LINES=32 TERM=xterm-256color CLAUDE_CONFIG_DIR=$env(TUI_CONFIG_ROOT) $env(TUI_NODE) $env(TUI_CLI) --dangerously-skip-permissions
stty rows 32 columns 100 < $spawn_out(slave,name)
expect -re {Praxis.*Code.*v${expectedVersionPattern}}
expect -re {shortcuts}
${hookNavigationTrace}
catch {exec kill -KILL [exp_pid]}
close
catch {wait}
exit 0
`
  const treesBeforeProviderlessProbe = await sharedTreeSnapshot()
  const providerlessEnvironment = { ...process.env }
  delete providerlessEnvironment.PRAXIS_API_KEY
  delete providerlessEnvironment.PRAXIS_MODEL
  let providerlessCapture
  try {
    providerlessCapture = await execFileAsync(
      'expect',
      ['-c', providerlessProbe],
      {
        cwd,
        env: {
          ...providerlessEnvironment,
          CI: 'true',
          PATH: `${binRoot}${delimiter}${dirname(claude)}${delimiter}${process.env.PATH ?? ''}`,
          TUI_CLI: cli,
          TUI_CONFIG_ROOT: configRoot,
          TUI_NODE: process.execPath,
          TUI_PLUGIN_ROOT: pluginRoot,
        },
        // The probe has many individually bounded screen transitions. Keep each
        // Expect assertion at 60s while allowing the complete trace to finish on
        // loaded CI hosts.
        timeout: 180_000,
      },
    )
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : ''
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    throw new Error(
      `Providerless hooks trace stopped after: ${hookNavigationContract(stdout).join(' -> ') || '(startup)'}${stderr ? `\n${stderr}` : ''}`,
      { cause: error },
    )
  }
  const providerlessContract = hookNavigationContract(
    providerlessCapture.stdout,
  )
  assert.deepEqual(providerlessContract, observedClaudeContract)
  assert.deepEqual(await sharedTreeSnapshot(), treesBeforeProviderlessProbe)

  const probe = String.raw`
set timeout 60
proc capture {path data} {
  set handle [open $path a]
  fconfigure $handle -translation binary
  puts -nonewline $handle $data
  close $handle
}
log_user 1
set phase "startup"
set t0 [clock milliseconds]
expect_before timeout {
  puts stderr "DBG phase=$phase elapsed=[expr {[clock milliseconds]-$t0}]ms"
  puts stderr "TUI compatibility timed out during $phase"
  exit 1
}
spawn -noecho env COLUMNS=100 LINES=32 TERM=xterm-256color NODE_OPTIONS=--import=$env(TUI_DOCTOR_FETCH_SHIM) EDITOR=$env(TUI_EDITOR) CLAUDE_CONFIG_DIR=$env(TUI_CONFIG_ROOT) PRAXIS_PROVIDER=openai PRAXIS_API_KEY=fixture-key PRAXIS_MODEL=fixture-model PRAXIS_BASE_URL=$env(TUI_PROVIDER_URL) $env(TUI_NODE) $env(TUI_CLI) --dangerously-skip-permissions --add-dir $env(TUI_SHARED_ROOT) --plugin-dir $env(TUI_PLUGIN_ROOT)
stty rows 32 columns 100 < $spawn_out(slave,name)
expect {
  -re {Praxis.*Code.*v${expectedVersionPattern}} { puts stderr "DBG header matched elapsed=[expr {[clock milliseconds]-$t0}]ms" }
  timeout { puts stderr "DBG header timeout elapsed=[expr {[clock milliseconds]-$t0}]ms welcome header did not render"; exit 1 }
  eof { puts stderr "Praxis exited before welcome header"; exit 1 }
}
expect -re {Tips for getting started} { puts stderr "DBG Tips at [expr {[clock milliseconds]-$t0}]ms" }
expect -re {Welcome back!} { puts stderr "DBG Welcome at [expr {[clock milliseconds]-$t0}]ms" }
expect -re {Try.*review this project} { puts stderr "DBG Try at [expr {[clock milliseconds]-$t0}]ms" }
expect -re {bypass permissions on} { puts stderr "DBG bypass at [expr {[clock milliseconds]-$t0}]ms" }
set phase "shortcut help"
send "?"
expect -re {! for bash mode}
expect -re {ctrl.*o for verbose output}
send "?"
expect -re {bypass permissions on.*\? for shortcuts}
set phase "slash palette"
send "/"
expect -re {/clear}
send "rev"
expect -re {/review}
expect -re {Review the shared fixture}
expect -re {❯[^\r\n]*\/rev}
send "\033"
expect {
  -re {Review the shared fixture} { puts stderr "slash palette remained open after Escape"; exit 1 }
  -re {❯[^\r\n]*\/rev} {}
}
send "\025"
expect -re {Try.*review this project}
set phase "hooks dialog"
${hookNavigationTrace}
send "\033"
after 200
send "\033"
after 200
send "\033"
expect -re {Try.*review this project}
set phase "add-dir command"
send "/add-dir"
expect -re {Add a new working directory}
send "\r"
expect -re {Add directory to workspace}
expect -re {Tab to complete.*Enter to add}
send "\033"
after 100
expect -re {Did not add a working directory}
set phase "diff dialog"
send "/diff"
expect -re {View uncommitted changes}
send "\r"
expect -re {Uncommitted changes.*git diff HEAD}
expect -re {fixture.txt}
send "\r"
expect -re {-DIFF_ENABLED_BEFORE}
expect -re {\+DIFF_ENABLED_AFTER}
send "\033"
after 100
expect -re {Enter to view}
send "\033"
after 100
expect -re {bypass permissions on}
set phase "permissions dialog"
send "/permissions"
expect -re {Manage allow and deny tool permission rules}
send "\r"
expect -re {Recently denied.*Allow.*Ask.*Deny.*Workspace}
expect -re {Praxis Code won't ask before using allowed tools}
expect -re {1\. Add a new rule}
expect -re {2\. Bash\(npm test:\*\)}
send "\033\[B"
after 100
send "\033\[B"
after 100
send "\r"
expect -re {Delete allowed tool}
expect -re {From user settings}
send "\r"
expect -re {1\. Add a new rule}
send "\033\[C"
after 100
send "\033\[C"
after 100
send "\033\[C"
expect -re {Original working directory}
expect -re {shared-access}
send "\033\[B"
after 100
send "\r"
expect -re {Remove directory from workspace}
expect -re {shared-access}
send "\r"
expect -re {Praxis Code won't ask before using allowed tools}
send "\033\[C"
after 100
send "\033\[C"
after 100
send "\033\[C"
expect -re {Original working directory}
send "\033\[B"
after 100
send "\r"
expect -re {Add directory to workspace}
expect -re {Tab to complete.*Enter to add}
send "\033"
after 100
expect -re {Praxis Code won't ask before using allowed tools}
send "\033"
after 100
expect -re {bypass permissions on}
set phase "theme dialog"
send "/theme"
expect -re {Change the theme}
send "\r"
expect -re {Choose the text style that looks best with your terminal}
expect -re {2\. Dark mode.*✔}
expect -re {Dark mode \(colorblind-friendly\)}
expect -re {Dark mode \(ANSI colors only\)}
expect -re {Syntax theme: Monokai Extended.*ctrl\+t to disable}
send "\024"
expect -re {Syntax highlighting disabled.*ctrl\+t to enable}
send "\024"
expect -re {Syntax theme: Monokai Extended.*ctrl\+t to disable}
send "\033\[B"
after 100
send "\033"
after 100
expect -re {bypass permissions on}
send "/theme"
after 100
send "\r"
expect -re {2\. Dark mode.*✔}
send "3"
after 100
expect -re {Syntax theme: GitHub.*ctrl\+t to disable}
send "\r"
expect -re {Theme set to light}
expect -re {bypass permissions on}
set phase "light diff after theme selection"
send "/diff"
after 100
send "\r"
expect -re {Uncommitted changes.*git diff HEAD}
send "\r"
expect -re {-DIFF_ENABLED_BEFORE}
expect -re {\+DIFF_ENABLED_AFTER}
send "\033"
after 100
send "\033"
after 100
set phase "context and status dialogs"
send "/context"
expect -re {Visualize current context usage}
send "\r"
set phase "context dialog"
expect -re {Context Usage}
set phase "context category legend"
expect -re {Estimated usage by category}
set phase "context free space"
expect -re {Free space}
set phase "context autocompact buffer"
expect -re {Autocompact buffer}
set phase "context memory heading"
expect -re {Memory files · /memory}
set phase "context memory loaded"
expect -re {~/.claude/CLAUDE.md: [0-9]+ tokens}
set phase "context skills source"
expect -re {Loaded}
set phase "context composer"
expect -re {Try.*review this project}
after 100
set phase "status dialog"
send "/status"
after 100
send "\r"
expect -re {Status.*Config.*Usage}
expect -re {fixture-model}
expect -re {Setting sources:}
send "\033"
expect -re {Try.*review this project}
after 100
set phase "doctor palette"
send "/doctor"
expect -re {Diagnose and verify your Claude Code installation and settings}
send "\r"
set phase "doctor installation status"
expect -re {Checking installation status}
set phase "doctor local diagnostics"
expect -re {Diagnostics}
expect -re {Currently running: Praxis ${expectedVersionPattern} \(npm\)}
expect -re {Search: OK \(system\)}
expect -re {Updates}
expect -re {Auto-updates: Manual \(praxis update\)}
expect -re {Update permissions: yes}
expect -re {Auto-update channel: latest}
set phase "doctor update status"
expect -re {Checking for updates}
set phase "doctor resolved updates"
expect -re {Stable version: 91\.2\.3}
expect -re {Latest version: 91\.2\.4}
send "\r"
expect -re {Try.*review this project}
after 100
set phase "skills dialog"
send "/skills"
after 100
send "\r"
expect -re {Skills}
expect -re {No skills found}
send "\033"
expect -re {Try.*review this project}
after 100
set phase "background tasks dialog"
send "\024"
expect -re {Background}
expect -re {No tasks currently running}
send "\033"
expect -re {Try.*review this project}
after 100
set phase "external editor"
send "seed prompt"
expect -re {❯.*seed prompt}
send "\007"
expect -re {Save and close editor to continue}
expect -re {edited first line}
expect -re {edited second line}
expect -re {ctrl.*g to edit in Editor-wrapper}
send "\025"
expect -re {Try.*review this project}
after 100
set phase "keybindings editor"
send "/keybindings"
after 100
send "\r"
expect -re {Created.*keybindings.json.*with}
expect -re {template.*Opened.*editor}
send "\025"
expect -re {Try.*review this project}
after 100
set phase "clipboard paste"
send "clipboard:"
after 100
send "\026"
expect -re {clipboard:INSTALLED_CLIPBOARD}
send "\025"
expect -re {Try.*review this project}
after 100
set phase "shell mode"
send "!"
expect -re {! for bash mode}
send "pwd"
expect -re {!.*pwd}
after 100
send "\r"
expect {
  -re {⎿.*work} {}
  timeout { puts stderr "shell result did not render"; exit 1 }
  eof { puts stderr "Praxis exited before shell result"; exit 1 }
}
expect -re {⏺.*TUI_FAKE_OK}
expect -re {Context.*3 tokens}
expect -re {Try.*review this project}
after 100
set phase "model turn"
puts "ANSI_ENABLED_BEGIN"
send "reply briefly"
expect -re {❯.*reply briefly}
after 100
send "\r"
expect -re {\r\n(     [^\r\n]*-ENABLED_TOOL_OLD[^\r\n]*)}
capture $env(TUI_ENABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {\r\n(     [^\r\n]*\+ENABLED_TOOL_NEW[^\r\n]*)}
capture $env(TUI_ENABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {\r\n(     [^\r\n]*EDIT_ENABLED_OLD[^\r\n]*)}
capture $env(TUI_ENABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {\r\n(     [^\r\n]*EDIT_ENABLED_NEW[^\r\n]*)}
capture $env(TUI_ENABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect {
  -re {TUI_MODEL_OK} {}
  timeout { puts stderr "assistant response did not render"; exit 1 }
  eof { puts stderr "Praxis exited before assistant response"; exit 1 }
}
expect -re {([^\r\n]*runtimeEnabledSentinel)}
capture $env(TUI_ENABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {([^\r\n]*enabled-runtime-string")}
capture $env(TUI_ENABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {Try.*review this project}
set phase "enabled runtime diff"
send "/diff"
after 100
send "\r"
expect -re {Uncommitted changes.*git diff HEAD}
send "\r"
expect -re {([^\r\n]*-DIFF_ENABLED_BEFORE)}
capture $env(TUI_ENABLED_DIFF_CAPTURE) "$expect_out(0,string)"
expect -re {([^\r\n]*\+DIFF_ENABLED_AFTER)}
capture $env(TUI_ENABLED_DIFF_CAPTURE) "$expect_out(0,string)"
send "\033"
after 100
send "\033"
expect -re {Try.*review this project}
after 300
puts "ANSI_ENABLED_END"
# Ink may include the restored empty composer in the same repaint that emitted
# the response. Continuing with /cd below proves the composer is interactive
# without depending on which fragment expect consumes from that repaint.
after 300
set phase "change working directory"
send "/cd"
after 300
send "\r"
expect -re {Usage: /cd <path>}
send "/cd $env(TUI_MOVED_ROOT)"
after 300
send "\r"
expect -re {Moved to}
expect -re {moved-work}
expect -re {Try.*review this project}
after 300
set phase "hooks after cwd change"
send "/hooks"
expect -re {View hook configurations}
send "\r"
expect -re {6 hooks configured}
send "1"
after 100
send "\r"
expect -re {\[Project\][^\r\n]*02-project[^\r\n]*1 hook}
expect -re {\[Plugin\][^\r\n]*04-plugin[^\r\n]*1 hook}
send "2"
after 100
send "\r"
expect -re {\[prompt\][^\r\n]*Moved project prompt[^\r\n]*Project Settings}
expect -re {Esc to go back}
after 300
send "\033"
after 200
send "\033\[A"
after 100
send "\r"
expect -re {\[agent\][^\r\n]*Moved local agent[^\r\n]*Local Settings}
expect -re {Esc to go back}
after 300
send "\033"
after 200
expect -re {PreToolUse - Matchers}
after 100
send "\033"
expect -re {6 hooks configured}
after 100
send "\033"
expect -re {Try.*review this project}
set phase "hooks after plugin reload"
exec $env(TUI_NODE) $env(TUI_PLUGIN_RELOADER) $env(TUI_PLUGIN_HOOKS)
send "/reload-plugins"
expect -re {Activate pending plugin changes}
send "\r"
expect -re {Plugin changes activated for this session}
send "/hooks"
expect -re {View hook configurations}
send "\r"
expect -re {6 hooks configured}
send "1"
after 100
send "\r"
expect -re {\[Plugin\][^\r\n]*04-plugin[^\r\n]*1 hook}
send "\033\[B"
after 100
send "\033\[B"
after 100
send "\033\[B"
after 100
send "\r"
expect -re {\[http\][^\r\n]*https://fixture.test/plugin-reloaded[^\r\n]*Plugin Hooks}
expect -re {Esc to go back}
after 300
send "\033"
after 200
expect -re {PreToolUse - Matchers}
after 100
send "\033"
expect -re {6 hooks configured}
after 100
send "\033"
expect -re {Try.*review this project}
after 300
set phase "shell mode after cd"
send "!"
expect -re {! for bash mode}
send "pwd"
after 100
send "\r"
expect -re {⎿.*moved-work}
expect -re {⏺.*TUI_FAKE_OK}
expect -re {Try.*review this project}
after 300
set phase "rename session"
send "/rename installed-title"
after 300
send "\r"
expect -re {Session renamed to: installed-title}
after 300
set phase "btw usage"
send "/btw"
after 300
send "\r"
expect -re {Usage: /btw <your question>}
set phase "btw answer"
send "/btw Reply with SIDE only."
after 300
send "\r"
expect -re {/btw Reply with SIDE only.}
expect -re {SIDE}
expect -re {c to copy.*f to fork}
set phase "btw copy"
send "c"
expect -re {52;c;U0lERQ==}
expect -re {Copied to clipboard}
set phase "btw fork"
send "f"
expect -re {⑂ forked reply-with-side \([0-9a-f]{4}\)}
expect -re {Try.*review this project}
set phase "copy response"
send "/copy"
after 100
send "\r"
expect -re {Select content to copy:}
expect -re {Full response}
expect -re {Always copy full response}
send "\r"
expect -re {Copied to clipboard \([0-9]+ characters, [0-9]+ lines\)}
set phase "export conversation"
send "/export"
expect -re {Export the current conversation}
after 100
send "\r"
expect -re {Export conversation}
expect -re {Copy to clipboard}
send "\r"
expect -re {Conversation copied to clipboard}
set phase "rewind menu"
send "/rewind"
expect -re {Restore the code and/or conversation}
after 100
send "\r"
expect -re {Rewind}
expect -re {current}
expect -re {Enter to continue.*Esc to cancel}
after 300
send "\033"
expect -re {Try.*review this project}
set phase "branch conversation"
send "/branch"
expect -re {Create a branch of the current conversation}
after 100
send "\r"
expect -re {Branched conversation.*new branch}
set phase "memory dialog"
send "/memory"
expect -re {Open a memory file in your editor}
after 100
send "\r"
expect -re {Auto-memory: on}
expect -re {User memory}
expect -re {Saved in ~/.claude/CLAUDE.md}
expect -re {imported.md}
expect -re {Project memory}
expect -re {Saved in ./CLAUDE.md}
expect -re {Open auto-memory folder}
set phase "memory imported editor"
send "2"
expect -re {Opened memory file at .*imported.md}
expect -re {Using Editor-wrapper}
after 100
set phase "memory folder launcher"
send "/memory"
expect -re {Open a memory file in your editor}
send "\r"
expect -re {Auto-memory: on}
send "4"
expect -re {Open auto-memory folder.*✔}
send "\033"
expect -re {Cancelled memory editing}
after 100
set phase "memory provider reload"
send "memory reload probe"
expect -re {❯.*memory reload probe}
send "\r"
expect -re {MEMORY_RELOAD_OK}
set phase "first TUI exit"
send "\003"
expect -re {Press Ctrl-C again to exit}
send "\003"
expect eof

set phase "suspend and resume"
spawn -noecho env COLUMNS=100 LINES=32 TERM=xterm-256color PATH=$env(PATH) CLAUDE_CONFIG_DIR=$env(TUI_CONFIG_ROOT) PRAXIS_PROVIDER=openai PRAXIS_API_KEY=fixture-key PRAXIS_MODEL=fixture-model PRAXIS_BASE_URL=$env(TUI_PROVIDER_URL) zsh -f
stty rows 32 columns 100 < $spawn_out(slave,name)
expect -re {[%#] }
send "export PS1=PRAXIS_SHELL\\>\\ \r"
expect -re {PRAXIS_SHELL> }
send "$env(TUI_NODE) $env(TUI_CLI) --dangerously-skip-permissions\r"
expect -re {bypass permissions on}
send "suspend seed"
expect -re {❯.*suspend seed}
send "\032"
expect -re {Praxis Code has been suspended.*Run .*fg.*bring Praxis Code back}
expect -re {ctrl.*z now suspends Praxis Code.*ctrl.*_ undoes input}
expect -re {PRAXIS_SHELL> }
send "jobs -l\r"
expect -re {suspended.*dangerously-skip-permissions}
after 200
set phase "foreground resume"
send "fg\r"
expect -re {❯.*suspend seed}
after 100
set phase "resumed TUI exit"
send "\003"
expect -re {Press Ctrl-C again to exit}
send "\003"
expect -re {PRAXIS_SHELL> }
after 100
set phase "shell exit"
send "exit\r"
expect eof
exit 0
`
  let result
  try {
    result = await execFileAsync('expect', ['-c', probe], {
      cwd,
      env: {
        ...tuiProbeEnvironment,
        CI: 'true',
        PATH: `${binRoot}${delimiter}${dirname(pinnedClaude)}${delimiter}${process.env.PATH ?? ''}`,
        TUI_CLI: cli,
        TUI_CLIPBOARD_OUTPUT: clipboardOutput,
        TUI_CONFIG_ROOT: configRoot,
        TUI_DOCTOR_FETCH_SHIM: doctorFetchShim,
        TUI_EDITOR: editor,
        TUI_EDITOR_OUTPUT: editorOutput,
        TUI_ENABLED_DIFF_CAPTURE: enabledDiffCapture,
        TUI_ENABLED_RUNTIME_CAPTURE: enabledRuntimeCapture,
        TUI_FOLDER_OUTPUT: folderOutput,
        TUI_MOVED_ROOT: movedCwd,
        TUI_NODE: process.execPath,
        TUI_PLUGIN_HOOKS: pluginHooks,
        TUI_PLUGIN_RELOADER: pluginReloader,
        TUI_PLUGIN_ROOT: pluginRoot,
        TUI_PROVIDER_URL: `http://127.0.0.1:${port}/v1`,
        TUI_SHARED_ROOT: sharedRoot,
      },
      timeout: 180_000,
    })
  } catch (error) {
    const stdout =
      error && typeof error === 'object' && 'stdout' in error
        ? String(error.stdout)
        : ''
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr).trim()
        : ''
    if (stdout) {
      console.error(stdout.slice(-8_000))
    }
    throw new Error(
      `TUI compatibility probe failed${stderr ? `: ${stderr}` : ''}`,
    )
  }
  assert.match(result.stdout, /TUI_FAKE_OK/u)
  const lightRemovedAnsi = ['\u001B[48;5;224m', '\u001B[48;2;255;215;215m']
  const lightAddedAnsi = ['\u001B[48;5;194m', '\u001B[48;2;215;255;215m']
  const enabledRuntimeOutput = await readFile(enabledRuntimeCapture, 'utf8')
  const enabledDiffOutput = await readFile(enabledDiffCapture, 'utf8')
  assertAnsiStyled(
    enabledRuntimeOutput,
    'function',
    ['\u001B[38;5;125m', '\u001B[38;2;175;0;95m'],
    'enabled transcript keyword',
  )
  assertAnsiStyled(
    enabledRuntimeOutput,
    'runtimeEnabledSentinel',
    ['\u001B[38;5;97m', '\u001B[38;2;135;95;175m'],
    'enabled transcript identifier',
  )
  assertAnsiStyled(
    enabledRuntimeOutput,
    '"enabled-runtime-string"',
    ['\u001B[38;5;24m', '\u001B[38;2;0;95;135m'],
    'enabled transcript string',
  )
  for (const [payload, ansiCodes, label] of [
    ['-ENABLED_TOOL_OLD', lightRemovedAnsi, 'enabled tool-result removal'],
    ['+ENABLED_TOOL_NEW', lightAddedAnsi, 'enabled tool-result addition'],
    ['-EDIT_ENABLED_OLD', lightRemovedAnsi, 'enabled Edit removal'],
    ['+EDIT_ENABLED_NEW', lightAddedAnsi, 'enabled Edit addition'],
  ]) {
    assertAnsiStyled(enabledRuntimeOutput, payload, ansiCodes, label)
  }
  assertAnsiStyled(
    enabledDiffOutput,
    '-DIFF_ENABLED_BEFORE',
    lightRemovedAnsi,
    'enabled /diff removal',
  )
  assertAnsiStyled(
    enabledDiffOutput,
    '+DIFF_ENABLED_AFTER',
    lightAddedAnsi,
    'enabled /diff addition',
  )
  assert.equal(
    await readFile(join(configRoot, 'CLAUDE.md'), 'utf8'),
    '# Shared user memory\n@imported.md\n',
  )
  assert.equal(
    await readFile(join(cwd, 'CLAUDE.md'), 'utf8'),
    '# Shared project memory\n',
  )
  assert.equal(await readFile(importedMemory, 'utf8'), `${importedAfter}\n`)
  assert.equal(
    (await readFile(editorOutput, 'utf8')).trim(),
    await realpath(importedMemory),
  )
  const openedFolder = (await readFile(folderOutput, 'utf8')).trim()
  assert.equal(basename(openedFolder), 'memory')
  assert.ok(
    (await realpath(openedFolder)).startsWith(
      `${await realpath(configRoot)}${sep}`,
    ),
  )
  const memoryReloadRequest = providerRequests.findLast((request) =>
    JSON.stringify(request.messages ?? []).includes('memory reload probe'),
  )
  assert.ok(
    memoryReloadRequest,
    'installed /memory emitted no next provider turn',
  )
  const memoryReloadSource = JSON.stringify(memoryReloadRequest)
  assert.match(memoryReloadSource, new RegExp(importedAfter, 'u'))
  assert.doesNotMatch(memoryReloadSource, new RegExp(importedBefore, 'u'))
  assert.deepEqual(
    hookNavigationContract(result.stdout),
    observedClaudeContract,
  )
  const projectRoot = join(configRoot, 'projects')
  const transcriptFiles = (await readdir(projectRoot, { recursive: true }))
    .map(String)
    .filter((file) => file.endsWith('.jsonl') && !file.includes('/subagents/'))
  assert.equal(transcriptFiles.length, 2)
  const transcripts = await Promise.all(
    transcriptFiles.map(async (file) => ({
      file,
      content: await readFile(join(projectRoot, file), 'utf8'),
    })),
  )
  const originalTranscript = transcripts.find(
    ({ content }) =>
      content.includes('"customTitle":"installed-title"') &&
      !content.includes('installed-title (Branch)'),
  )
  const branchTranscript = transcripts.find(({ content }) =>
    content.includes('installed-title (Branch)'),
  )
  assert.ok(originalTranscript)
  assert.ok(branchTranscript)
  const transcript = originalTranscript.content
  const canonicalMovedCwd = await realpath(movedCwd)
  assert.match(
    transcript,
    new RegExp(
      `"type":"relocated","sessionId":"[^"]+","relocatedCwd":"${canonicalMovedCwd.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"`,
      'u',
    ),
  )
  assert.match(transcript, /<command-name>\/cd<\/command-name>/u)
  assert.match(transcript, /<command-name>\/btw<\/command-name>/u)
  assert.match(transcript, /⑂ forked reply-with-side \([0-9a-f]{4}\)/u)
  assert.match(transcript, /"type":"queue-operation","operation":"enqueue"/u)
  assert.match(transcript, /<task-notification>/u)
  assert.match(
    transcript,
    /<local-command-stdout>Usage: \/cd <path><\/local-command-stdout>/u,
  )
  assert.match(transcript, /<local-command-stdout>Moved to /u)
  assert.match(transcript, /The session's working directory has changed to /u)
  const transcriptEntries = transcripts.flatMap(({ content }) =>
    content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  )
  assert.ok(
    transcriptEntries.some(
      (entry) =>
        typeof entry.message?.content === 'string' &&
        entry.message.content.includes('<bash-stdout>'),
    ),
  )
  assert.match(transcript, /<bash-input>pwd<\/bash-input>/u)
  assert.match(transcript, /<bash-stdout>[^<]*work\\n<\/bash-stdout>/u)
  assert.match(transcript, /<bash-stderr><\/bash-stderr>/u)
  const inputHistory = await readFile(join(configRoot, 'history.jsonl'), 'utf8')
  assert.match(inputHistory, /"display":"\/btw"/u)
  assert.match(inputHistory, /"display":"\/btw Reply with SIDE only\."/u)
  const sidechainFiles = (await readdir(projectRoot, { recursive: true }))
    .map(String)
    .filter(
      (file) => file.includes('/subagents/agent-') && file.endsWith('.jsonl'),
    )
  assert.equal(sidechainFiles.length, 1)
  const clipboard = await readFile(clipboardOutput, 'utf8')
  assert.doesNotMatch(clipboard, /Welcome back!/u)
  assert.match(clipboard, /❯ reply briefly/u)
  assert.match(clipboard, /⏺ TUI_FAKE_OK/u)
  assert.match(clipboard, /❯ \/export/u)
  const resumeProbe = String.raw`
set timeout 15
proc capture {path data} {
  set handle [open $path a]
  fconfigure $handle -translation binary
  puts -nonewline $handle $data
  close $handle
}
proc assert_style {row label expected first second} {
  set styled [expr {[string first $first $row] >= 0 || [string first $second $row] >= 0}]
  if {$styled != $expected} {
    puts stderr "$label ANSI style mismatch"
    exit 1
  }
}
log_user 1
spawn -noecho env COLUMNS=100 LINES=32 TERM=xterm-256color CLAUDE_CONFIG_DIR=$env(TUI_CONFIG_ROOT) PRAXIS_PROVIDER=openai PRAXIS_API_KEY=fixture-key PRAXIS_MODEL=fixture-model PRAXIS_BASE_URL=$env(TUI_PROVIDER_URL) $env(TUI_NODE) $env(TUI_CLI) --resume $env(TUI_SESSION_ID) --dangerously-skip-permissions
stty rows 32 columns 100 < $spawn_out(slave,name)
puts "ANSI_RESTART_ENABLED_BEGIN"
expect -re {\r\n(     [^\r\n]*-ENABLED_TOOL_OLD[^\r\n]*)}
capture $env(TUI_RESTART_ENABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {\r\n(     [^\r\n]*\+ENABLED_TOOL_NEW[^\r\n]*)}
capture $env(TUI_RESTART_ENABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {\r\n(     [^\r\n]*EDIT_ENABLED_OLD[^\r\n]*)}
capture $env(TUI_RESTART_ENABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {\r\n(     [^\r\n]*EDIT_ENABLED_NEW[^\r\n]*)}
capture $env(TUI_RESTART_ENABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect {
  -re {([^\r\n]*runtimeEnabledSentinel)} {}
  timeout { puts stderr "enabled transcript history did not render after restart"; exit 1 }
  eof { puts stderr "Praxis exited before enabled restart history"; exit 1 }
}
capture $env(TUI_RESTART_ENABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {([^\r\n]*enabled-runtime-string")}
capture $env(TUI_RESTART_ENABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {Try.*review this project}
send "/diff"
after 100
send "\r"
expect -re {Uncommitted changes.*git diff HEAD}
send "\r"
expect -re {([^\r\n]*-DIFF_RESTART_ENABLED_BEFORE)} {
  assert_style $expect_out(0,string) "restarted enabled /diff removal" 1 $env(TUI_LIGHT_REMOVED_256) $env(TUI_LIGHT_REMOVED_RGB)
}
expect -re {([^\r\n]*\+DIFF_RESTART_ENABLED_AFTER)} {
  assert_style $expect_out(0,string) "restarted enabled /diff addition" 1 $env(TUI_LIGHT_ADDED_256) $env(TUI_LIGHT_ADDED_RGB)
}
send "\033"
after 100
send "\033"
expect -re {Try.*review this project}
after 300
puts "ANSI_RESTART_ENABLED_END"
send "/theme"
expect -re {Change the theme}
send "\r"
expect -re {3\. Light mode.*✔}
expect -re {Syntax theme: GitHub.*ctrl\+t to disable}
send "\024"
expect -re {Syntax highlighting disabled.*ctrl\+t to enable}
send "\033"
expect -re {Try.*review this project}
exec $env(TUI_NODE) -e {require('node:fs').writeFileSync(process.argv[1], process.argv[2])} $env(TUI_DIFF_FILE) "DIFF_DISABLED_BEFORE\n"
exec git -C $env(TUI_MOVED_ROOT) add fixture.txt
exec git -C $env(TUI_MOVED_ROOT) -c user.name=PraxisFixture -c user.email=fixture@example.com commit -qm disabled-baseline
exec $env(TUI_NODE) -e {require('node:fs').writeFileSync(process.argv[1], process.argv[2])} $env(TUI_DIFF_FILE) "DIFF_DISABLED_AFTER\n"
puts "ANSI_DISABLED_BEGIN"
send "disabled surface probe"
after 100
send "\r"
expect -re {\r\n(     [^\r\n]*-DISABLED_TOOL_OLD[^\r\n]*)}
capture $env(TUI_DISABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {\r\n(     [^\r\n]*\+DISABLED_TOOL_NEW[^\r\n]*)}
capture $env(TUI_DISABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {\r\n(     [^\r\n]*EDIT_DISABLED_OLD[^\r\n]*)}
capture $env(TUI_DISABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {\r\n(     [^\r\n]*EDIT_DISABLED_NEW[^\r\n]*)}
capture $env(TUI_DISABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {TUI_DISABLED_OK}
expect -re {([^\r\n]*runtimeDisabledSentinel)}
capture $env(TUI_DISABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {([^\r\n]*disabled-runtime-string")}
capture $env(TUI_DISABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {Try.*review this project}
send "/diff"
after 100
send "\r"
expect -re {Uncommitted changes.*git diff HEAD}
send "\r"
expect -re {([^\r\n]*-DIFF_DISABLED_BEFORE)}
capture $env(TUI_DISABLED_DIFF_CAPTURE) "$expect_out(0,string)"
expect -re {([^\r\n]*\+DIFF_DISABLED_AFTER)}
capture $env(TUI_DISABLED_DIFF_CAPTURE) "$expect_out(0,string)"
send "\033"
after 100
send "\033"
expect -re {Try.*review this project}
after 300
puts "ANSI_DISABLED_END"
send "\003"
expect -re {Press Ctrl-C again to exit}
send "\003"
expect eof
exit 0
`
  await execFileAsync('expect', ['-c', resumeProbe], {
    cwd: movedCwd,
    env: {
      ...tuiProbeEnvironment,
      CI: 'true',
      PATH: `${binRoot}${delimiter}${dirname(pinnedClaude)}${delimiter}${process.env.PATH ?? ''}`,
      TUI_CLI: cli,
      TUI_CONFIG_ROOT: configRoot,
      TUI_DIFF_FILE: join(movedCwd, 'fixture.txt'),
      TUI_DISABLED_DIFF_CAPTURE: disabledDiffCapture,
      TUI_DISABLED_RUNTIME_CAPTURE: disabledRuntimeCapture,
      TUI_MOVED_ROOT: movedCwd,
      TUI_NODE: process.execPath,
      TUI_PROVIDER_URL: `http://127.0.0.1:${port}/v1`,
      TUI_RESTART_ENABLED_RUNTIME_CAPTURE: restartedEnabledRuntimeCapture,
      TUI_LIGHT_ADDED_256: lightAddedAnsi[0],
      TUI_LIGHT_ADDED_RGB: lightAddedAnsi[1],
      TUI_LIGHT_REMOVED_256: lightRemovedAnsi[0],
      TUI_LIGHT_REMOVED_RGB: lightRemovedAnsi[1],
      TUI_SESSION_ID: basename(branchTranscript.file, '.jsonl'),
    },
    timeout: 120_000,
  })
  const restartedEnabledRuntimeOutput = await readFile(
    restartedEnabledRuntimeCapture,
    'utf8',
  )
  const disabledRuntimeOutput = await readFile(disabledRuntimeCapture, 'utf8')
  const disabledDiffOutput = await readFile(disabledDiffCapture, 'utf8')
  assertAnsiStyled(
    restartedEnabledRuntimeOutput,
    'runtimeEnabledSentinel',
    ['\u001B[38;5;97m', '\u001B[38;2;135;95;175m'],
    'restarted enabled transcript',
  )
  for (const [payload, ansiCodes, label] of [
    [
      '-ENABLED_TOOL_OLD',
      lightRemovedAnsi,
      'restarted enabled tool-result removal',
    ],
    [
      '+ENABLED_TOOL_NEW',
      lightAddedAnsi,
      'restarted enabled tool-result addition',
    ],
    ['-EDIT_ENABLED_OLD', lightRemovedAnsi, 'restarted enabled Edit removal'],
    ['+EDIT_ENABLED_NEW', lightAddedAnsi, 'restarted enabled Edit addition'],
  ]) {
    assertAnsiStyled(restartedEnabledRuntimeOutput, payload, ansiCodes, label)
  }
  for (const [payload, ansiCodes, label] of [
    [
      'runtimeDisabledSentinel',
      ['\u001B[38;5;97m', '\u001B[38;2;135;95;175m'],
      'disabled transcript identifier',
    ],
    [
      '"disabled-runtime-string"',
      ['\u001B[38;5;24m', '\u001B[38;2;0;95;135m'],
      'disabled transcript string',
    ],
  ]) {
    assert.ok(
      disabledRuntimeOutput.includes(payload),
      `${label} payload did not render`,
    )
    assertNotAnsiStyled(disabledRuntimeOutput, payload, ansiCodes, label)
  }
  for (const [payload, ansiCodes, label] of [
    ['-DISABLED_TOOL_OLD', lightRemovedAnsi, 'disabled tool-result removal'],
    ['+DISABLED_TOOL_NEW', lightAddedAnsi, 'disabled tool-result addition'],
    ['-EDIT_DISABLED_OLD', lightRemovedAnsi, 'disabled Edit removal'],
    ['+EDIT_DISABLED_NEW', lightAddedAnsi, 'disabled Edit addition'],
  ]) {
    assert.ok(
      disabledRuntimeOutput.includes(payload.replace(/^[+-]/u, '')),
      `${label} payload did not render`,
    )
    assertNotAnsiStyled(disabledRuntimeOutput, payload, ansiCodes, label)
  }
  for (const [payload, ansiCodes, label] of [
    ['-DIFF_DISABLED_BEFORE', lightRemovedAnsi, 'disabled /diff removal'],
    ['+DIFF_DISABLED_AFTER', lightAddedAnsi, 'disabled /diff addition'],
  ]) {
    assert.ok(
      disabledDiffOutput.includes(payload.replace(/^[+-]/u, '')),
      `${label} payload did not render`,
    )
    assertNotAnsiStyled(disabledDiffOutput, payload, ansiCodes, label)
  }
  const movedDiffFixture = join(movedCwd, 'fixture.txt')
  await writeFile(movedDiffFixture, 'DIFF_RESTART_DISABLED_BEFORE\n')
  await execFileAsync('git', ['add', 'fixture.txt'], { cwd: movedCwd })
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Praxis Fixture',
      '-c',
      'user.email=fixture@example.com',
      'commit',
      '-qm',
      'disabled restart baseline',
    ],
    { cwd: movedCwd },
  )
  await writeFile(movedDiffFixture, 'DIFF_RESTART_DISABLED_AFTER\n')
  const disabledRestartProbe = String.raw`
set timeout 15
proc capture {path data} {
  set handle [open $path a]
  fconfigure $handle -translation binary
  puts -nonewline $handle $data
  close $handle
}
log_user 1
proc assert_style {row label expected first second} {
  set styled [expr {[string first $first $row] >= 0 || [string first $second $row] >= 0}]
  if {$styled != $expected} {
    puts stderr "$label ANSI style mismatch"
    exit 1
  }
}
spawn -noecho env COLUMNS=100 LINES=32 TERM=xterm-256color CLAUDE_CONFIG_DIR=$env(TUI_CONFIG_ROOT) PRAXIS_PROVIDER=openai PRAXIS_API_KEY=fixture-key PRAXIS_MODEL=fixture-model PRAXIS_BASE_URL=$env(TUI_PROVIDER_URL) $env(TUI_NODE) $env(TUI_CLI) --resume $env(TUI_SESSION_ID) --dangerously-skip-permissions
stty rows 32 columns 100 < $spawn_out(slave,name)
puts "ANSI_RESTART_DISABLED_BEGIN"
expect -re {\r\n(     [^\r\n]*-DISABLED_TOOL_OLD[^\r\n]*)}
capture $env(TUI_RESTART_DISABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {\r\n(     [^\r\n]*\+DISABLED_TOOL_NEW[^\r\n]*)}
capture $env(TUI_RESTART_DISABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {\r\n(     [^\r\n]*EDIT_DISABLED_OLD[^\r\n]*)}
capture $env(TUI_RESTART_DISABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {\r\n(     [^\r\n]*EDIT_DISABLED_NEW[^\r\n]*)}
capture $env(TUI_RESTART_DISABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect {
  -re {([^\r\n]*runtimeDisabledSentinel)} {}
  timeout { puts stderr "disabled transcript history did not render after restart"; exit 1 }
  eof { puts stderr "Praxis exited before disabled restart history"; exit 1 }
}
capture $env(TUI_RESTART_DISABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {([^\r\n]*disabled-runtime-string")}
capture $env(TUI_RESTART_DISABLED_RUNTIME_CAPTURE) "$expect_out(0,string)"
expect -re {Try.*review this project}
send "/diff"
after 100
send "\r"
expect -re {Uncommitted changes.*git diff HEAD}
send "\r"
expect -re {([^\r\n]*-DIFF_RESTART_DISABLED_BEFORE)} {
  assert_style $expect_out(0,string) "restarted disabled /diff removal" 0 $env(TUI_LIGHT_REMOVED_256) $env(TUI_LIGHT_REMOVED_RGB)
}
expect -re {([^\r\n]*\+DIFF_RESTART_DISABLED_AFTER)} {
  assert_style $expect_out(0,string) "restarted disabled /diff addition" 0 $env(TUI_LIGHT_ADDED_256) $env(TUI_LIGHT_ADDED_RGB)
}
send "\033"
after 100
send "\033"
expect -re {Try.*review this project}
after 300
puts "ANSI_RESTART_DISABLED_END"
send "/compact"
expect -re {Clear conversation history.*summary}
send "\r"
expect -re {Compacted.*ctrl\+o.*full summary}
send "\017"
expect -re {TUI_DISABLED_OK}
send "\003"
expect -re {Press Ctrl-C again to exit}
send "\003"
expect eof
exit 0
`
  await execFileAsync('expect', ['-c', disabledRestartProbe], {
    cwd: movedCwd,
    env: {
      ...tuiProbeEnvironment,
      CI: 'true',
      PATH: `${binRoot}${delimiter}${dirname(pinnedClaude)}${delimiter}${process.env.PATH ?? ''}`,
      TUI_CLI: cli,
      TUI_CONFIG_ROOT: configRoot,
      TUI_NODE: process.execPath,
      TUI_PLUGIN_ROOT: pluginRoot,
      TUI_PROVIDER_URL: `http://127.0.0.1:${port}/v1`,
      TUI_RESTART_DISABLED_RUNTIME_CAPTURE: restartedDisabledRuntimeCapture,
      TUI_LIGHT_ADDED_256: lightAddedAnsi[0],
      TUI_LIGHT_ADDED_RGB: lightAddedAnsi[1],
      TUI_LIGHT_REMOVED_256: lightRemovedAnsi[0],
      TUI_LIGHT_REMOVED_RGB: lightRemovedAnsi[1],
      TUI_SESSION_ID: basename(branchTranscript.file, '.jsonl'),
    },
    timeout: 120_000,
  })
  const restartedDisabledRuntimeOutput = await readFile(
    restartedDisabledRuntimeCapture,
    'utf8',
  )
  for (const [payload, ansiCodes, label] of [
    [
      'runtimeDisabledSentinel',
      ['\u001B[38;5;97m', '\u001B[38;2;135;95;175m'],
      'restarted disabled transcript identifier',
    ],
    [
      '"disabled-runtime-string"',
      ['\u001B[38;5;24m', '\u001B[38;2;0;95;135m'],
      'restarted disabled transcript string',
    ],
  ]) {
    assert.ok(
      restartedDisabledRuntimeOutput.includes(payload),
      `${label} payload did not render`,
    )
    assertNotAnsiStyled(
      restartedDisabledRuntimeOutput,
      payload,
      ansiCodes,
      label,
    )
  }
  for (const [payload, ansiCodes, label] of [
    [
      '-DISABLED_TOOL_OLD',
      lightRemovedAnsi,
      'restarted disabled tool-result removal',
    ],
    [
      '+DISABLED_TOOL_NEW',
      lightAddedAnsi,
      'restarted disabled tool-result addition',
    ],
    ['-EDIT_DISABLED_OLD', lightRemovedAnsi, 'restarted disabled Edit removal'],
    ['+EDIT_DISABLED_NEW', lightAddedAnsi, 'restarted disabled Edit addition'],
  ]) {
    assert.ok(
      restartedDisabledRuntimeOutput.includes(payload.replace(/^[+-]/u, '')),
      `${label} payload did not render`,
    )
    assertNotAnsiStyled(
      restartedDisabledRuntimeOutput,
      payload,
      ansiCodes,
      label,
    )
  }
  assert.match(
    await readFile(join(configRoot, 'keybindings.json'), 'utf8'),
    /"ctrl\+v": "chat:imagePaste"/u,
  )
  assert.deepEqual(
    JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8'))
      .permissions.allow,
    [],
  )
  assert.deepEqual(
    JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8')).hooks,
    {
      PreToolUse: [
        {
          matcher: '01-user',
          hooks: [
            {
              type: 'command',
              command: 'printf fixture-hook',
              statusMessage: 'User command',
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: '05-user-post',
          hooks: [{ type: 'command', command: 'printf post-hook' }],
        },
      ],
    },
  )
  assert.equal(
    JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8')).theme,
    'light',
  )
  assert.equal(
    JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8'))
      .syntaxHighlightingDisabled,
    true,
  )
  console.log('TUI compatibility verification passed')
} finally {
  await new Promise((resolve) => provider.close(resolve))
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })
}
