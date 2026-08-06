import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export interface TmuxWorktreeLaunchOptions {
  argv: readonly string[]
  cwd: string
  cliPath: string
  worktreeName?: string
  attach: boolean
}

function generatedName(): string {
  return `praxis-${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

function tmuxName(worktreeName: string): string {
  const normalized = worktreeName.replace(/[^A-Za-z0-9_-]+/gu, '-').slice(0, 48)
  return `praxis-${normalized || generatedName()}`
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

function runTmux(
  args: readonly string[],
  inheritStdio: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', args, {
      stdio: inheritStdio ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    if (!inheritStdio) {
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk
      })
    }
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `tmux exited with code ${code}`))
    })
  })
}

export async function launchTmuxWorktree(
  options: TmuxWorktreeLaunchOptions,
): Promise<{ sessionName: string; worktreeName: string }> {
  const child = tmuxChildArgv(options.argv, options.worktreeName)
  const sessionName = tmuxName(child.worktreeName)
  await runTmux(
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
    false,
  )
  if (options.attach) {
    await runTmux(['attach-session', '-t', sessionName], true)
  }
  return { sessionName, worktreeName: child.worktreeName }
}
