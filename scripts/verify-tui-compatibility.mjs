import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-tui-compat-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'work')
const sharedRoot = join(root, 'shared-access')
const installRoot = join(root, 'install')
const binRoot = join(root, 'bin')
const claude = join(binRoot, 'claude')
const editor = join(binRoot, 'editor-wrapper')
const osascript = join(binRoot, 'osascript')
const pbpaste = join(binRoot, 'pbpaste')
const wlPaste = join(binRoot, 'wl-paste')
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
    mkdir(configRoot, { recursive: true }),
    mkdir(join(configRoot, 'commands'), { recursive: true }),
    mkdir(join(configRoot, 'agents'), { recursive: true }),
    mkdir(cwd),
    mkdir(sharedRoot),
    mkdir(installRoot),
    mkdir(binRoot),
  ])
  await writeFile(
    join(configRoot, 'commands', 'review.md'),
    '---\ndescription: Review the shared fixture.\n---\nReview $ARGUMENTS\n',
  )
  await writeFile(
    join(configRoot, 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviews the shared fixture.\n---\nReview the requested fixture.\n',
  )
  await writeFile(
    join(configRoot, 'settings.json'),
    `${JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] } }, null, 2)}\n`,
  )
  const diffFixture = join(cwd, 'fixture.txt')
  await writeFile(diffFixture, 'before\n')
  await execFileAsync('git', ['init', '-q'], { cwd })
  await execFileAsync('git', ['add', 'fixture.txt'], { cwd })
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
    { cwd },
  )
  await writeFile(diffFixture, 'after\n')
  await writeFile(claude, "#!/bin/sh\nprintf '2.1.208 (Claude Code)\\n'\n")
  await chmod(claude, 0o755)
  await writeFile(
    editor,
    '#!/bin/sh\ncase "$1" in *keybindings.json) exit 0 ;; esac\nprintf \'edited first line\\nedited second line\\n\\n\' > "$1"\n',
  )
  await chmod(editor, 0o755)
  await writeFile(osascript, '#!/bin/sh\nexit 1\n')
  await writeFile(pbpaste, "#!/bin/sh\nprintf 'INSTALLED_CLIPBOARD'\n")
  await writeFile(
    wlPaste,
    '#!/bin/sh\ncase "$*" in *image/png*) exit 1 ;; *) printf \'INSTALLED_CLIPBOARD\' ;; esac\n',
  )
  await Promise.all([
    chmod(osascript, 0o755),
    chmod(pbpaste, 0o755),
    chmod(wlPaste, 0o755),
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

  const probe = String.raw`
set timeout 15
log_user 1
set phase "startup"
expect_before timeout {
  puts stderr "TUI compatibility timed out during $phase"
  exit 1
}
spawn -noecho env COLUMNS=100 LINES=32 TERM=xterm-256color EDITOR=$env(TUI_EDITOR) CLAUDE_CONFIG_DIR=$env(TUI_CONFIG_ROOT) PRAXIS_PROVIDER=openai PRAXIS_API_KEY=fixture-key PRAXIS_MODEL=fixture-model PRAXIS_BASE_URL=$env(TUI_PROVIDER_URL) $env(TUI_NODE) $env(TUI_CLI) --dangerously-skip-permissions --add-dir $env(TUI_SHARED_ROOT)
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
set phase "shortcut help"
send "?"
expect -re {! for shell mode}
expect -re {ctrl.*o for verbose output}
send "?"
expect -re {bypass permissions on.*\? for shortcuts}
set phase "slash palette"
send "/"
expect -re {/clear}
send "rev"
expect -re {/review}
expect -re {Review the shared fixture}
send "\033"
expect -re {❯ /rev}
send "\025"
expect -re {Try.*review this project}
set phase "diff dialog"
send "/diff"
expect -re {View uncommitted changes}
send "\r"
expect -re {Uncommitted changes.*git diff HEAD}
expect -re {fixture.txt}
send "\r"
expect -re {-before}
expect -re {\+after}
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
set phase "file and agent mentions"
send "@fix"
expect -re {\+ fixture.txt}
send "\r"
expect -re {❯ @fixture.txt}
send "\037"
expect -re {❯ @fix}
send "\025"
expect -re {Try.*review this project}
send "@rev"
expect -re {reviewer.*\(agent\)}
send "\r"
expect -re {❯.*reviewer.*agent}
send "\025"
expect -re {Try.*review this project}
set phase "context and status dialogs"
send "/context"
expect -re {Visualize current context usage}
send "\r"
set phase "context dialog"
expect -re {Context Usage}
expect -re {Auto-compact window}
expect -re {Try.*review this project}
after 100
set phase "status dialog"
send "/status"
after 100
send "\r"
expect -re {Settings.*Status.*Config.*Usage.*Stats}
expect -re {fixture-model}
send "\033"
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
expect -re {! for shell mode}
send "pwd"
expect -re {!.*pwd}
after 100
send "\r"
expect {
  -re {⎿.*work} {}
  timeout { puts stderr "shell result did not render"; exit 1 }
  eof { puts stderr "Praxis exited before shell result"; exit 1 }
}
expect -re {TUI_FAKE_OK}
expect -re {Context.*3 tokens}
expect -re {Try.*review this project}
after 100
set phase "model turn"
send "reply briefly"
expect -re {❯.*reply briefly}
after 100
send "\r"
expect {
  -re {TUI_FAKE_OK} {}
  timeout { puts stderr "assistant response did not render"; exit 1 }
  eof { puts stderr "Praxis exited before assistant response"; exit 1 }
}
expect -re {Context.*3 tokens}
expect -re {Try.*review this project}
after 100
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
        ...process.env,
        CI: 'true',
        PATH: `${binRoot}${delimiter}${process.env.PATH ?? ''}`,
        TUI_CLI: cli,
        TUI_CONFIG_ROOT: configRoot,
        TUI_EDITOR: editor,
        TUI_NODE: process.execPath,
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
  const projectRoot = join(configRoot, 'projects')
  const transcriptFiles = (await readdir(projectRoot, { recursive: true }))
    .map(String)
    .filter((file) => file.endsWith('.jsonl'))
  assert.equal(transcriptFiles.length, 1)
  const transcript = await readFile(
    join(projectRoot, transcriptFiles[0]),
    'utf8',
  )
  assert.match(transcript, /<bash-input>pwd<\/bash-input>/u)
  assert.match(transcript, /<bash-stdout>[^<]*work\\n<\/bash-stdout>/u)
  assert.match(transcript, /<bash-stderr><\/bash-stderr>/u)
  const resumeProbe = String.raw`
set timeout 15
log_user 1
spawn -noecho env COLUMNS=100 LINES=32 TERM=xterm-256color CLAUDE_CONFIG_DIR=$env(TUI_CONFIG_ROOT) PRAXIS_PROVIDER=openai PRAXIS_API_KEY=fixture-key PRAXIS_MODEL=fixture-model PRAXIS_BASE_URL=$env(TUI_PROVIDER_URL) $env(TUI_NODE) $env(TUI_CLI) --resume $env(TUI_SESSION_ID) --dangerously-skip-permissions
stty rows 32 columns 100 < $spawn_out(slave,name)
expect {
  -re {!.*pwd} {}
  timeout { puts stderr "resumed shell history did not render"; exit 1 }
  eof { puts stderr "Praxis exited before resumed shell history"; exit 1 }
}
expect -re {⎿.*work}
expect -re {❯.*reply briefly}
expect -re {TUI_FAKE_OK}
send "\003"
expect -re {Press Ctrl-C again to exit}
send "\003"
expect eof
exit 0
`
  await execFileAsync('expect', ['-c', resumeProbe], {
    cwd,
    env: {
      ...process.env,
      CI: 'true',
      TUI_CLI: cli,
      TUI_CONFIG_ROOT: configRoot,
      TUI_NODE: process.execPath,
      TUI_PROVIDER_URL: `http://127.0.0.1:${port}/v1`,
      TUI_SESSION_ID: basename(transcriptFiles[0], '.jsonl'),
    },
    timeout: 60_000,
  })
  assert.match(
    await readFile(join(configRoot, 'keybindings.json'), 'utf8'),
    /"ctrl\+v": "chat:imagePaste"/u,
  )
  assert.deepEqual(
    JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8'))
      .permissions.allow,
    [],
  )
  console.log('TUI compatibility verification passed')
} finally {
  await new Promise((resolve) => provider.close(resolve))
  await rm(root, { recursive: true, force: true })
}
