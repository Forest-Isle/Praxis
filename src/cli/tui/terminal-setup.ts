import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises'
import { homedir, platform as hostPlatform } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { writeFileAtomically } from '../../platform/atomic-write.js'
import {
  resolveDataPlane,
  resolveDataPlaneRoot,
} from '../../persistence/data-plane.js'
import type { TuiSlashCommand } from './slash-commands.js'

const execFileAsync = promisify(execFile)

type TerminalSetupRunner = (
  command: string,
  arguments_: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export interface TuiTerminalSetupOptions {
  environment?: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
  homeDirectory?: string
  run?: TerminalSetupRunner
}

type SetupTerminal =
  | 'Apple_Terminal'
  | 'vscode'
  | 'cursor'
  | 'windsurf'
  | 'alacritty'
  | 'zed'
  | 'ghostty'
  | 'kitty'
  | 'iTerm.app'
  | 'WezTerm'
  | 'WarpTerminal'
  | string

const NATIVE_SHIFT_ENTER_TERMINALS: Readonly<Record<string, string>> = {
  ghostty: 'Ghostty',
  kitty: 'Kitty',
  'iTerm.app': 'iTerm2',
  WezTerm: 'WezTerm',
  WarpTerminal: 'Warp',
}

const SETUP_SUPPORTED_TERMINALS = new Set([
  'vscode',
  'cursor',
  'windsurf',
  'alacritty',
  'zed',
])

const MAX_CONFIGURATION_BYTES = 4 * 1024 * 1024

function ownHome(options: TuiTerminalSetupOptions): string {
  return options.homeDirectory ?? homedir()
}

function ownEnvironment(
  options: TuiTerminalSetupOptions,
): Readonly<Record<string, string | undefined>> {
  return options.environment ?? process.env
}

function ownPlatform(options: TuiTerminalSetupOptions): NodeJS.Platform {
  return options.platform ?? hostPlatform()
}

async function runTerminalCommand(
  command: string,
  arguments_: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, [...arguments_], {
      encoding: 'utf8',
      maxBuffer: MAX_CONFIGURATION_BYTES,
    })
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string
      stderr?: string
      code?: number | string
    }
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message,
    }
  }
}

export function detectTuiTerminal(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SetupTerminal | null {
  if (environment.CURSOR_TRACE_ID) return 'cursor'
  const askpass = environment.VSCODE_GIT_ASKPASS_MAIN ?? ''
  if (askpass.includes('cursor')) return 'cursor'
  if (askpass.includes('windsurf')) return 'windsurf'
  const bundleId = environment.__CFBundleIdentifier?.toLowerCase()
  if (bundleId?.includes('windsurf')) return 'windsurf'
  if (bundleId?.includes('vscode') || bundleId?.includes('vscodium'))
    return 'vscode'
  if (environment.TERM === 'xterm-ghostty') return 'ghostty'
  if (environment.TERM?.includes('kitty')) return 'kitty'
  if (environment.TERM_PROGRAM) return environment.TERM_PROGRAM
  if (environment.TMUX) return 'tmux'
  if (environment.STY) return 'screen'
  if (environment.KITTY_WINDOW_ID) return 'kitty'
  if (environment.ALACRITTY_LOG || environment.TERM?.includes('alacritty'))
    return 'alacritty'
  if (environment.ZED_TERM) return 'zed'
  if (environment.TERM) return environment.TERM
  return null
}

export function nativeShiftEnterTerminalName(
  terminal: string | null,
): string | null {
  if (!terminal) return null
  return NATIVE_SHIFT_ENTER_TERMINALS[terminal] ?? null
}

export function terminalSetupTuiSlashCommand(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = hostPlatform(),
): TuiSlashCommand | null {
  const terminal = detectTuiTerminal(environment)
  if (nativeShiftEnterTerminalName(terminal)) return null
  return {
    name: 'terminal-setup',
    description:
      terminal === 'Apple_Terminal' && platform === 'darwin'
        ? 'Enable Option+Enter key binding for newlines and visual bell'
        : 'Install Shift+Enter key binding for newlines',
    source: 'builtin',
  }
}

function isVsCodeRemoteSsh(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  const askpass = environment.VSCODE_GIT_ASKPASS_MAIN ?? ''
  const path = environment.PATH ?? ''
  return (
    askpass.includes('.vscode-server') ||
    askpass.includes('.cursor-server') ||
    askpass.includes('.windsurf-server') ||
    path.includes('.vscode-server') ||
    path.includes('.cursor-server') ||
    path.includes('.windsurf-server')
  )
}

function terminalUnavailableMessage(
  terminal: string | null,
  platform: NodeJS.Platform,
): string {
  const platformTerminals =
    platform === 'darwin'
      ? '   • macOS: Apple Terminal\n'
      : platform === 'win32'
        ? '   • Windows: Windows Terminal\n'
        : ''
  return `Terminal setup cannot be run from ${terminal ?? 'your current terminal'}.

This command configures a convenient Shift+Enter shortcut for multi-line prompts.
Note: You can already use backslash (\\) + return to add newlines.

To set up the shortcut (optional):
1. Exit tmux/screen temporarily
2. Run /terminal-setup directly in one of these terminals:
${platformTerminals}   • IDE: VSCode, Cursor, Windsurf, Zed
   • Other: Alacritty
3. Return to tmux/screen - settings will persist

Note: iTerm2, WezTerm, Ghostty, Kitty, and Warp support Shift+Enter natively.`
}

function manualVsCodeRemoteMessage(editor: string): string {
  return `Cannot install keybindings from a remote ${editor} session.

${editor} keybindings must be installed on your local machine, not the remote server.

To install the Shift+Enter keybinding:
1. Open ${editor} on your local machine (not connected to remote)
2. Open the Command Palette (Cmd/Ctrl+Shift+P) → "Preferences: Open Keyboard Shortcuts (JSON)"
3. Add this keybinding (the file must be a JSON array):

[
  {
    "key": "shift+enter",
    "command": "workbench.action.terminal.sendSequence",
    "args": { "text": "\\u001b\\r" },
    "when": "terminalFocus"
  }
]`
}

async function regularFileOrMissing(path: string): Promise<boolean> {
  try {
    const status = await lstat(path)
    if (status.isSymbolicLink() || !status.isFile())
      throw new Error(`Configuration path must be a regular file: ${path}`)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function readConfiguration(path: string): Promise<{
  source: string
  exists: boolean
}> {
  const exists = await regularFileOrMissing(path)
  if (!exists) return { source: '', exists: false }
  const source = await readFile(path, 'utf8')
  if (Buffer.byteLength(source) > MAX_CONFIGURATION_BYTES)
    throw new Error(`Configuration file is too large: ${path}`)
  return { source, exists: true }
}

function withoutJsoncComments(source: string): string {
  let result = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? ''
    const next = source[index + 1] ?? ''
    if (lineComment) {
      if (character === '\n' || character === '\r') {
        lineComment = false
        result += character
      } else result += ' '
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        result += '  '
        index += 1
      } else
        result += character === '\n' || character === '\r' ? character : ' '
      continue
    }
    if (quote) {
      result += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      result += character
      continue
    }
    if (character === '/' && next === '/') {
      lineComment = true
      result += '  '
      index += 1
      continue
    }
    if (character === '/' && next === '*') {
      blockComment = true
      result += '  '
      index += 1
      continue
    }
    result += character
  }
  if (quote || blockComment) throw new Error('Invalid JSONC configuration')
  return result
}

function parseJsoncArray(source: string, path: string): unknown[] {
  const normalized = withoutJsoncComments(source).replace(/,(\s*[}\]])/gu, '$1')
  let value: unknown
  try {
    value = JSON.parse(normalized)
  } catch (error) {
    throw new Error(`Invalid JSONC configuration: ${path}`, { cause: error })
  }
  if (!Array.isArray(value))
    throw new Error(`Configuration must be a JSON array: ${path}`)
  return value
}

function findJsonArrayClosingBracket(source: string): number {
  const normalized = withoutJsoncComments(source)
  const start = normalized.search(/\S/u)
  if (start < 0 || normalized[start] !== '[')
    throw new Error('Configuration must be a JSON array')
  let quote: '"' | "'" | null = null
  let escaped = false
  let depth = 0
  for (let index = start; index < normalized.length; index += 1) {
    const character = normalized[index] ?? ''
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '[') depth += 1
    if (character !== ']') continue
    depth -= 1
    if (depth === 0) return index
  }
  throw new Error('Configuration must be a complete JSON array')
}

function appendJsoncArrayItem(source: string, value: unknown): string {
  const closing = findJsonArrayClosingBracket(source)
  const before = source.slice(0, closing)
  const after = source.slice(closing)
  const normalizedBefore = withoutJsoncComments(before)
  const opening = normalizedBefore.indexOf('[')
  const hasExistingItem =
    opening >= 0 &&
    normalizedBefore.slice(opening + 1).replace(/[\s,]/gu, '').length > 0
  const item = JSON.stringify(value, null, 2)
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
  const separator =
    hasExistingItem && !normalizedBefore.trimEnd().endsWith(',') ? ',' : ''
  return `${before}${separator}\n${item}\n${after}`
}

async function backupBeforeMutation(path: string): Promise<string | null> {
  const exists = await regularFileOrMissing(path)
  if (!exists) return null
  const backupPath = `${path}.${randomUUID().slice(0, 8)}.bak`
  await copyFile(path, backupPath)
  return backupPath
}

async function writeConfiguration(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const committed = await writeFileAtomically(path, source, { mode: 0o600 })
  if (!committed) throw new Error(`Configuration changed concurrently: ${path}`)
}

type VsCodeBinding = {
  key?: unknown
  command?: unknown
  when?: unknown
}

function hasVsCodeShiftEnterBinding(bindings: readonly unknown[]): boolean {
  return bindings.some(
    (entry): entry is VsCodeBinding =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as VsCodeBinding).key === 'shift+enter' &&
      (entry as VsCodeBinding).command ===
        'workbench.action.terminal.sendSequence' &&
      (entry as VsCodeBinding).when === 'terminalFocus',
  )
}

function vsCodeKeybindingsPath(
  editor: 'VSCode' | 'Cursor' | 'Windsurf',
  options: TuiTerminalSetupOptions,
): string {
  const platform = ownPlatform(options)
  const home = ownHome(options)
  const directory = editor === 'VSCode' ? 'Code' : editor
  const userDirectory =
    platform === 'win32'
      ? join(
          ownEnvironment(options).APPDATA ?? join(home, 'AppData', 'Roaming'),
          directory,
          'User',
        )
      : platform === 'darwin'
        ? join(home, 'Library', 'Application Support', directory, 'User')
        : join(home, '.config', directory, 'User')
  return join(userDirectory, 'keybindings.json')
}

async function installVsCodeBinding(
  editor: 'VSCode' | 'Cursor' | 'Windsurf',
  options: TuiTerminalSetupOptions,
): Promise<string> {
  const environment = ownEnvironment(options)
  if (isVsCodeRemoteSsh(environment)) return manualVsCodeRemoteMessage(editor)
  const path = vsCodeKeybindingsPath(editor, options)
  try {
    const current = await readConfiguration(path)
    const bindings = current.exists ? parseJsoncArray(current.source, path) : []
    if (hasVsCodeShiftEnterBinding(bindings))
      return `Found existing ${editor} terminal Shift+Enter key binding. Remove it to continue.\nSee ${path}`
    await backupBeforeMutation(path)
    const binding = {
      key: 'shift+enter',
      command: 'workbench.action.terminal.sendSequence',
      args: { text: '\u001b\r' },
      when: 'terminalFocus',
    }
    const next = current.exists
      ? appendJsoncArrayItem(current.source, binding)
      : `${JSON.stringify([binding], null, 2)}\n`
    await writeConfiguration(path, next)
    return `Installed ${editor} terminal Shift+Enter key binding\nSee ${path}`
  } catch (error) {
    return `Failed to install ${editor} terminal Shift+Enter key binding: ${
      error instanceof Error ? error.message : String(error)
    }`
  }
}

function alacrittyConfigurationPaths(
  options: TuiTerminalSetupOptions,
): readonly string[] {
  const environment = ownEnvironment(options)
  const home = ownHome(options)
  const paths = [
    join(
      environment.XDG_CONFIG_HOME ?? join(home, '.config'),
      'alacritty',
      'alacritty.toml',
    ),
  ]
  if (ownPlatform(options) === 'win32' && environment.APPDATA)
    paths.push(join(environment.APPDATA, 'alacritty', 'alacritty.toml'))
  return paths
}

function hasAlacrittyShiftEnterBinding(source: string): boolean {
  return source
    .split(/^\s*\[\[keyboard\.bindings\]\]\s*$/mu)
    .slice(1)
    .some(
      (block) =>
        /^\s*key\s*=\s*["']Return["']/mu.test(block) &&
        /^\s*mods\s*=\s*["']Shift["']/mu.test(block),
    )
}

async function alacrittyConfigPath(
  options: TuiTerminalSetupOptions,
): Promise<{ path: string; source: string; exists: boolean }> {
  const paths = alacrittyConfigurationPaths(options)
  for (const path of paths) {
    const current = await readConfiguration(path)
    if (current.exists) return { path, ...current }
  }
  const path = paths[0]
  if (!path) throw new Error('No valid Alacritty configuration path')
  return { path, source: '', exists: false }
}

async function installAlacrittyBinding(
  options: TuiTerminalSetupOptions,
): Promise<string> {
  try {
    const current = await alacrittyConfigPath(options)
    if (current.exists && hasAlacrittyShiftEnterBinding(current.source))
      return `Found existing Alacritty Shift+Enter key binding. Remove it to continue.\nSee ${current.path}`
    await backupBeforeMutation(current.path)
    const prefix =
      current.source.length === 0 || current.source.endsWith('\n')
        ? current.source
        : `${current.source}\n`
    await writeConfiguration(
      current.path,
      `${prefix}\n[[keyboard.bindings]]\nkey = "Return"\nmods = "Shift"\nchars = "\\u001B\\r"\n`,
    )
    return `Installed Alacritty Shift+Enter key binding\nYou may need to restart Alacritty for changes to take effect\nSee ${current.path}`
  } catch (error) {
    return `Failed to install Alacritty Shift+Enter key binding: ${
      error instanceof Error ? error.message : String(error)
    }`
  }
}

function zedKeymapPath(options: TuiTerminalSetupOptions): string {
  return join(ownHome(options), '.config', 'zed', 'keymap.json')
}

type ZedKeymap = {
  context?: unknown
  bindings?: unknown
}

function hasZedShiftEnterBinding(keymap: readonly unknown[]): boolean {
  return keymap.some((entry) => {
    if (typeof entry !== 'object' || entry === null) return false
    const record = entry as ZedKeymap
    if (typeof record.bindings !== 'object' || record.bindings === null)
      return false
    return Object.hasOwn(record.bindings, 'shift-enter')
  })
}

async function installZedBinding(
  options: TuiTerminalSetupOptions,
): Promise<string> {
  const path = zedKeymapPath(options)
  try {
    const current = await readConfiguration(path)
    const keymap = current.exists ? parseJsoncArray(current.source, path) : []
    if (hasZedShiftEnterBinding(keymap))
      return `Found existing Zed Shift+Enter key binding. Remove it to continue.\nSee ${path}`
    await backupBeforeMutation(path)
    const next = [
      ...keymap,
      {
        context: 'Terminal',
        bindings: { 'shift-enter': ['terminal::SendText', '\u001b\r'] },
      },
    ]
    await writeConfiguration(path, `${JSON.stringify(next, null, 2)}\n`)
    return `Installed Zed Shift+Enter key binding\nSee ${path}`
  } catch (error) {
    return `Failed to install Zed Shift+Enter key binding: ${
      error instanceof Error ? error.message : String(error)
    }`
  }
}

function appleTerminalPlistPath(options: TuiTerminalSetupOptions): string {
  return join(
    ownHome(options),
    'Library',
    'Preferences',
    'com.apple.Terminal.plist',
  )
}

function appleTerminalStatePath(options: TuiTerminalSetupOptions): string {
  const environment = ownEnvironment(options)
  const dataPlane = resolveDataPlane(environment)
  const root = resolveDataPlaneRoot({
    dataPlane,
    environment,
    homeDirectory: ownHome(options),
  })
  return join(
    root,
    dataPlane === 'native' ? 'state' : 'praxis',
    'terminal-setup.json',
  )
}

function validAppleTerminalProfile(profile: string): boolean {
  return /^[A-Za-z0-9 _.-]{1,128}$/u.test(profile)
}

async function writeAppleTerminalState(
  options: TuiTerminalSetupOptions,
  state: { status: 'in-progress' | 'complete'; backupPath: string },
): Promise<void> {
  const path = appleTerminalStatePath(options)
  await mkdir(dirname(path), { recursive: true })
  const committed = await writeFileAtomically(
    path,
    `${JSON.stringify(state, null, 2)}\n`,
    { mode: 0o600 },
  )
  if (!committed)
    throw new Error(`Terminal setup state changed concurrently: ${path}`)
}

async function readAppleTerminalState(
  options: TuiTerminalSetupOptions,
): Promise<{ status: 'in-progress' | 'complete'; backupPath: string } | null> {
  const path = appleTerminalStatePath(options)
  const source = await readConfiguration(path)
  if (!source.exists) return null
  let value: unknown
  try {
    value = JSON.parse(source.source)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (
    (record.status !== 'in-progress' && record.status !== 'complete') ||
    typeof record.backupPath !== 'string' ||
    !record.backupPath.startsWith(
      `${dirname(appleTerminalPlistPath(options))}/`,
    )
  )
    return null
  return { status: record.status, backupPath: record.backupPath }
}

async function restoreAppleTerminalBackup(
  backupPath: string,
  run: TerminalSetupRunner,
): Promise<boolean> {
  const restored = await run('defaults', [
    'import',
    'com.apple.Terminal',
    backupPath,
  ])
  if (restored.exitCode !== 0) return false
  await run('killall', ['cfprefsd'])
  return true
}

async function recoverIncompleteAppleTerminalSetup(
  options: TuiTerminalSetupOptions,
  run: TerminalSetupRunner,
): Promise<string | null> {
  const state = await readAppleTerminalState(options)
  if (!state || state.status !== 'in-progress') return null
  if (!(await regularFileOrMissing(state.backupPath))) return null
  if (await restoreAppleTerminalBackup(state.backupPath, run)) {
    await writeAppleTerminalState(options, {
      status: 'complete',
      backupPath: state.backupPath,
    })
    return 'Recovered incomplete Terminal.app setup from its backup. Run /terminal-setup again to apply it.'
  }
  return `A previous Terminal.app setup may be incomplete. Restore it manually with: defaults import com.apple.Terminal ${state.backupPath}`
}

async function updateAppleTerminalProfile(
  profile: string,
  plistPath: string,
  run: TerminalSetupRunner,
): Promise<boolean> {
  if (!validAppleTerminalProfile(profile))
    throw new Error('Terminal.app returned an unsafe profile name')
  const path = `:'Window Settings':'${profile}'`
  const option = await run('/usr/libexec/PlistBuddy', [
    '-c',
    `Add ${path}:useOptionAsMetaKey bool true`,
    plistPath,
  ])
  const optionEnabled =
    option.exitCode === 0 ||
    (
      await run('/usr/libexec/PlistBuddy', [
        '-c',
        `Set ${path}:useOptionAsMetaKey true`,
        plistPath,
      ])
    ).exitCode === 0
  const bell = await run('/usr/libexec/PlistBuddy', [
    '-c',
    `Add ${path}:Bell bool false`,
    plistPath,
  ])
  const bellDisabled =
    bell.exitCode === 0 ||
    (
      await run('/usr/libexec/PlistBuddy', [
        '-c',
        `Set ${path}:Bell false`,
        plistPath,
      ])
    ).exitCode === 0
  return optionEnabled || bellDisabled
}

async function installAppleTerminalSetup(
  options: TuiTerminalSetupOptions,
): Promise<string> {
  const run = options.run ?? runTerminalCommand
  const recovery = await recoverIncompleteAppleTerminalSetup(options, run)
  if (recovery) return recovery
  const plistPath = appleTerminalPlistPath(options)
  const backupPath = `${plistPath}.bak`
  try {
    await mkdir(dirname(plistPath), { recursive: true })
    const exported = await run('defaults', [
      'export',
      'com.apple.Terminal',
      backupPath,
    ])
    if (exported.exitCode !== 0 || !(await regularFileOrMissing(backupPath)))
      throw new Error('Failed to create a Terminal.app preferences backup')
    await writeAppleTerminalState(options, {
      status: 'in-progress',
      backupPath,
    })
    const [defaultProfile, startupProfile] = await Promise.all([
      run('defaults', [
        'read',
        'com.apple.Terminal',
        'Default Window Settings',
      ]),
      run('defaults', [
        'read',
        'com.apple.Terminal',
        'Startup Window Settings',
      ]),
    ])
    if (defaultProfile.exitCode !== 0 || !defaultProfile.stdout.trim())
      throw new Error('Failed to read the default Terminal.app profile')
    if (startupProfile.exitCode !== 0 || !startupProfile.stdout.trim())
      throw new Error('Failed to read the startup Terminal.app profile')
    const profiles = [
      ...new Set([defaultProfile.stdout.trim(), startupProfile.stdout.trim()]),
    ]
    const changed: boolean[] = []
    for (const profile of profiles) {
      changed.push(await updateAppleTerminalProfile(profile, plistPath, run))
    }
    if (!changed.some(Boolean))
      throw new Error('Failed to update Terminal.app profile settings')
    await run('killall', ['cfprefsd'])
    await writeAppleTerminalState(options, { status: 'complete', backupPath })
    return 'Configured Terminal.app settings:\n- Enabled "Use Option as Meta key"\n- Switched to visual bell\nOption+Enter will now enter a newline.\nYou must restart Terminal.app for changes to take effect.'
  } catch (error) {
    const restored = await restoreAppleTerminalBackup(backupPath, run)
    if (restored) {
      await writeAppleTerminalState(options, {
        status: 'complete',
        backupPath,
      }).catch(() => undefined)
      return 'Failed to enable Option as Meta key for Terminal.app. Your settings have been restored from backup.'
    }
    return `Failed to enable Option as Meta key for Terminal.app: ${
      error instanceof Error ? error.message : String(error)
    }`
  }
}

/**
 * Diagnose or install the terminal-local newline binding used by the Claude
 * compatible composer. This intentionally operates outside shared transcripts:
 * terminal preferences belong to the local single-user machine.
 */
export async function setupTuiTerminal(
  options: TuiTerminalSetupOptions = {},
): Promise<string> {
  const terminal = detectTuiTerminal(ownEnvironment(options))
  const nativeName = nativeShiftEnterTerminalName(terminal)
  if (nativeName)
    return `Shift+Enter is natively supported in ${nativeName}.

No configuration needed. Just use Shift+Enter to add newlines.`
  if (terminal === 'Apple_Terminal' && ownPlatform(options) === 'darwin')
    return installAppleTerminalSetup(options)
  if (!terminal || !SETUP_SUPPORTED_TERMINALS.has(terminal))
    return terminalUnavailableMessage(terminal, ownPlatform(options))
  switch (terminal) {
    case 'vscode':
      return installVsCodeBinding('VSCode', options)
    case 'cursor':
      return installVsCodeBinding('Cursor', options)
    case 'windsurf':
      return installVsCodeBinding('Windsurf', options)
    case 'alacritty':
      return installAlacrittyBinding(options)
    case 'zed':
      return installZedBinding(options)
    default:
      return terminalUnavailableMessage(terminal, ownPlatform(options))
  }
}
