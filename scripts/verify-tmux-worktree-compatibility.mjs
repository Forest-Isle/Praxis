import { execFile } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'praxis-tmux-compat-'))
const installRoot = join(root, 'install')
const repository = join(root, 'repo')
const bin = join(root, 'bin')
const claudeConfigRoot = join(root, 'claude-config')
const log = join(root, 'calls.jsonl')
let praxisCli = ''

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function run(args, environment = {}) {
  return execFileAsync(process.execPath, [praxisCli, ...args], {
    cwd: repository,
    env: {
      ...process.env,
      ...environment,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      PRAXIS_TMUX_LOG: log,
      DISABLE_AUTOUPDATER: '1',
    },
    timeout: 30_000,
  })
}

async function calls() {
  try {
    return (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function clearCalls() {
  await rm(log, { force: true })
}

async function failure(args, marker) {
  try {
    await run(args)
  } catch (error) {
    const output = `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`
    assert(
      error.code !== 0,
      `command unexpectedly succeeded: ${args.join(' ')}`,
    )
    assert(output.includes(marker), `missing ${marker}: ${output}`)
    return
  }
  throw new Error(`expected failure: ${args.join(' ')}`)
}

try {
  await Promise.all([
    mkdir(installRoot, { recursive: true }),
    mkdir(repository, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(claudeConfigRoot, { recursive: true }),
  ])
  await writeFile(join(repository, 'fixture.txt'), 'fixture\n')
  await execFileAsync('git', ['init', '-q'], { cwd: repository })
  await execFileAsync('git', ['add', 'fixture.txt'], { cwd: repository })
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Praxis Fixture',
      '-c',
      'user.email=praxis@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: repository },
  )
  const fake = `#!/usr/bin/env node
import { appendFile } from 'node:fs/promises'
const command = process.argv[1].split('/').at(-1)
await appendFile(process.env.PRAXIS_TMUX_LOG, JSON.stringify({ command, args: process.argv.slice(2) }) + '\\n')
if (command === 'osascript') process.stdout.write('w0t1p2:fixture\\n')
`
  await Promise.all(
    ['tmux', 'osascript'].map(async (name) => {
      const path = join(bin, name)
      await writeFile(path, fake)
      await chmod(path, 0o755)
    }),
  )

  const packed = JSON.parse(
    (
      await execFileAsync(
        'npm',
        ['pack', '--json', '--pack-destination', root],
        {
          cwd: repositoryRoot,
          timeout: 120_000,
        },
      )
    ).stdout,
  )
  const filename = packed[0]?.filename
  assert(typeof filename === 'string', 'npm pack returned no artifact')
  await execFileAsync(
    'npm',
    [
      'install',
      '--prefix',
      installRoot,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(root, filename),
    ],
    { timeout: 120_000 },
  )
  praxisCli = join(
    installRoot,
    'node_modules',
    'praxis-agent',
    'dist',
    'cli.js',
  )

  const help = await run(['--help'])
  assert(
    help.stdout.includes('iTerm2 native pane'),
    'Praxis tmux help is stale',
  )
  await failure(['--tmux', 'prompt'], '--tmux requires --worktree')
  await failure(
    ['--worktree', '--tmux=invalid', 'prompt'],
    '--tmux must be classic',
  )

  const native = await run(
    [
      '--worktree=review',
      '--tmux',
      '--',
      "quote ' and ; $(touch should-not-run)",
    ],
    { TERM_PROGRAM: 'iTerm.app', LC_TERMINAL: '' },
  )
  assert(
    native.stdout === 'Started iTerm2 pane w0t1p2:fixture\n',
    `native output mismatch: ${native.stdout}`,
  )
  let recorded = await calls()
  assert(
    recorded.length === 1 && recorded[0].command === 'osascript',
    'native path did not use osascript',
  )
  assert(recorded[0].args[0] === '-e', 'AppleScript was not passed with -e')
  assert(
    !recorded[0].args[1].includes('should-not-run'),
    'user command was interpolated into AppleScript',
  )
  assert(
    recorded[0].args[2].includes(`'"'"'`),
    'single quote was not shell escaped',
  )
  assert(
    recorded[0].args[2].startsWith(`cd '${await realpath(repository)}' && `),
    'native pane cwd was not explicit',
  )
  assert(
    recorded[0].args[2].includes('--worktree=review'),
    'worktree metadata missing from child command',
  )
  assert(
    !recorded[0].args[2].includes("'--tmux'"),
    'tmux control leaked into child command',
  )

  await clearCalls()
  const classic = await run(
    ['--worktree=classic-review', '--tmux=classic', '--', 'inspect'],
    { TERM_PROGRAM: 'iTerm.app' },
  )
  assert(
    classic.stdout.includes('Started tmux session praxis-classic-review'),
    'classic output mismatch',
  )
  recorded = await calls()
  assert(
    recorded.length === 1 && recorded[0].command === 'tmux',
    'classic mode did not force tmux',
  )
  assert(
    recorded[0].args.slice(0, 2).join(' ') === 'new-session -d',
    'classic tmux creation args differ',
  )

  await clearCalls()
  const fallback = await run(
    ['--worktree=fallback', '--tmux', '--', 'inspect'],
    { TERM_PROGRAM: 'Apple_Terminal', LC_TERMINAL: '' },
  )
  assert(
    fallback.stdout.includes('Started tmux session praxis-fallback'),
    'non-iTerm fallback output mismatch',
  )
  recorded = await calls()
  assert(
    recorded.length === 1 && recorded[0].command === 'tmux',
    'non-iTerm path did not fall back to tmux',
  )

  const claude = await execFileAsync('claude', ['--help'], {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigRoot,
      DISABLE_AUTOUPDATER: '1',
    },
    timeout: 30_000,
  })
  assert(
    claude.stdout.includes('Uses iTerm2'),
    'Claude tmux help contract changed',
  )
  assert(
    claude.stdout.includes('--tmux=classic'),
    'Claude classic help contract changed',
  )

  process.stdout.write('tmux worktree packed compatibility verified\n')
} finally {
  await rm(root, { recursive: true, force: true })
}
