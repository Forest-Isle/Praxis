import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export interface TmuxWorktreeLaunchOptions {
  argv: readonly string[]
  cwd: string
  cliPath: string
  worktreeName?: string
  mode: 'native' | 'classic'
  attach: boolean
}

export interface TmuxWorktreeLaunchResult {
  kind: 'iterm' | 'tmux'
  sessionName: string
  worktreeName: string
}

interface CommandResult {
  stdout: string
}

export interface TmuxWorktreeDependencies {
  platform: NodeJS.Platform
  environment: NodeJS.ProcessEnv
  run(
    command: string,
    args: readonly string[],
    options: { inheritStdio: boolean },
  ): Promise<CommandResult>
}

const ITERM_SPLIT_SCRIPT = `on run argv
  set commandText to item 1 of argv
  tell application "iTerm2"
    if (count of windows) is 0 then error "iTerm2 has no active window"
    tell current session of current window
      set newSession to split vertically with default profile
    end tell
    tell newSession
      write text commandText
      return unique ID
    end tell
  end tell
end run`

function generatedName(): string {
  return `praxis-${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

function tmuxName(worktreeName: string): string {
  const normalized = worktreeName.replace(/[^A-Za-z0-9_-]+/gu, '-').slice(0, 48)
  return `praxis-${normalized || generatedName()}`
}

function shellQuote(value: string): string {
  if (value.includes('\0'))
    throw new Error('tmux child arguments must not contain NUL')
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function tmuxChildArgv(
  argv: readonly string[],
  worktreeName?: string,
): { argv: string[]; worktreeName: string } {
  const name = worktreeName ?? generatedName()
  const output: string[] = []
  let optionsEnded = false
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (optionsEnded) {
      if (value !== undefined) output.push(value)
      continue
    }
    if (value === '--') {
      optionsEnded = true
      output.push(value)
      continue
    }
    if (value === '--tmux' || value === '--tmux=classic') continue
    if (value?.startsWith('--tmux=')) continue
    if (
      worktreeName === undefined &&
      (value === '--worktree' || value === '-w')
    ) {
      output.push(`--worktree=${name}`)
      const candidate = argv[index + 1]
      if (
        candidate !== undefined &&
        candidate !== '--' &&
        !candidate.startsWith('-')
      ) {
        index += 1
      }
      continue
    }
    if (value !== undefined) output.push(value)
  }
  return { argv: output, worktreeName: name }
}

function defaultRun(
  command: string,
  args: readonly string[],
  options: { inheritStdio: boolean },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.inheritStdio ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    if (!options.inheritStdio) {
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        if (stdout.length < 64 * 1024) stdout += chunk
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        if (stderr.length < 64 * 1024) stderr += chunk
      })
    }
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout })
      else
        reject(
          new Error(
            stderr.trim() || `${command} exited with code ${String(code)}`,
          ),
        )
    })
  })
}

const defaultDependencies: TmuxWorktreeDependencies = {
  platform: process.platform,
  environment: process.env,
  run: defaultRun,
}

function supportsNativeIterm(dependencies: TmuxWorktreeDependencies): boolean {
  return (
    dependencies.platform === 'darwin' &&
    (dependencies.environment.TERM_PROGRAM === 'iTerm.app' ||
      dependencies.environment.LC_TERMINAL === 'iTerm2')
  )
}

function childCommand(
  options: TmuxWorktreeLaunchOptions,
  child: ReturnType<typeof tmuxChildArgv>,
): string {
  const command = [process.execPath, options.cliPath, ...child.argv]
    .map(shellQuote)
    .join(' ')
  return `cd ${shellQuote(options.cwd)} && ${command}`
}

async function launchClassic(
  options: TmuxWorktreeLaunchOptions,
  child: ReturnType<typeof tmuxChildArgv>,
  dependencies: TmuxWorktreeDependencies,
): Promise<TmuxWorktreeLaunchResult> {
  const sessionName = tmuxName(child.worktreeName)
  await dependencies.run(
    'tmux',
    [
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-c',
      options.cwd,
      process.execPath,
      options.cliPath,
      ...child.argv,
    ],
    { inheritStdio: false },
  )
  if (options.attach)
    await dependencies.run('tmux', ['attach-session', '-t', sessionName], {
      inheritStdio: true,
    })
  return { kind: 'tmux', sessionName, worktreeName: child.worktreeName }
}

export async function launchTmuxWorktree(
  options: TmuxWorktreeLaunchOptions,
  dependencies: TmuxWorktreeDependencies = defaultDependencies,
): Promise<TmuxWorktreeLaunchResult> {
  const child = tmuxChildArgv(options.argv, options.worktreeName)
  if (options.mode === 'native' && supportsNativeIterm(dependencies)) {
    const result = await dependencies.run(
      'osascript',
      ['-e', ITERM_SPLIT_SCRIPT, childCommand(options, child)],
      { inheritStdio: false },
    )
    const sessionName = result.stdout.trim()
    if (!/^[A-Za-z0-9:._-]{1,256}$/u.test(sessionName))
      throw new Error('iTerm2 returned an invalid pane session ID')
    return { kind: 'iterm', sessionName, worktreeName: child.worktreeName }
  }
  return launchClassic(options, child, dependencies)
}
