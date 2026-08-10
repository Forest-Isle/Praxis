import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-tui-compat-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'work')
const installRoot = join(root, 'install')
const binRoot = join(root, 'bin')
const claude = join(binRoot, 'claude')
let cli
let port
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

const provider = createServer(async (request, response) => {
  for await (const chunk of request) {
    // Drain request before responding so the real adapter lifecycle is tested.
    void chunk
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'TUI_FAKE_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
  )
})

try {
  await Promise.all([
    mkdir(configRoot),
    mkdir(join(configRoot, 'commands'), { recursive: true }),
    mkdir(cwd),
    mkdir(installRoot),
    mkdir(binRoot),
  ])
  await writeFile(
    join(configRoot, 'commands', 'review.md'),
    '---\ndescription: Review the shared fixture.\n---\nReview $ARGUMENTS\n',
  )
  await writeFile(claude, "#!/bin/sh\nprintf '2.1.208 (Claude Code)\\n'\n")
  await chmod(claude, 0o755)
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

  const probe = String.raw`
set timeout 15
log_user 1
spawn -noecho env COLUMNS=100 LINES=32 TERM=xterm-256color CLAUDE_CONFIG_DIR=$env(TUI_CONFIG_ROOT) PRAXIS_PROVIDER=openai PRAXIS_API_KEY=fixture-key PRAXIS_MODEL=fixture-model PRAXIS_BASE_URL=$env(TUI_PROVIDER_URL) $env(TUI_NODE) $env(TUI_CLI) --dangerously-skip-permissions
stty rows 32 columns 100 < $spawn_out(slave,name)
expect {
  -re {Praxis.*Code.*v${expectedVersionPattern}} {}
  timeout { puts stderr "welcome header did not render"; exit 1 }
  eof { puts stderr "Praxis exited before welcome header"; exit 1 }
}
expect -re {Welcome back!}
expect -re {Tips for getting started}
expect -re {Try.*review this project}
expect -re {bypass permissions on}
send "/"
expect -re {Commands}
expect -re {/clear}
expect -re {/review}
expect -re {Review the shared fixture}
expect -re {Tab fill}
send "\033"
send "reply briefly"
expect -re {❯.*reply briefly}
send "\r"
expect {
  -re {TUI_FAKE_OK} {}
  timeout { puts stderr "assistant response did not render"; exit 1 }
  eof { puts stderr "Praxis exited before assistant response"; exit 1 }
}
expect -re {Context.*3 tokens}
send "\003"
expect eof
exit 0
`
  const result = await execFileAsync('expect', ['-c', probe], {
    cwd,
    env: {
      ...process.env,
      CI: 'true',
      PATH: `${binRoot}${delimiter}${process.env.PATH ?? ''}`,
      TUI_CLI: cli,
      TUI_CONFIG_ROOT: configRoot,
      TUI_NODE: process.execPath,
      TUI_PROVIDER_URL: `http://127.0.0.1:${port}/v1`,
    },
    timeout: 30_000,
  })
  assert.match(result.stdout, /TUI_FAKE_OK/u)
  console.log('TUI compatibility verification passed')
} finally {
  await new Promise((resolve) => provider.close(resolve))
  await rm(root, { recursive: true, force: true })
}
