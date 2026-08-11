import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
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
const claude = join(binRoot, 'claude')
const editor = join(binRoot, 'editor-wrapper')
const osascript = join(binRoot, 'osascript')
const pbpaste = join(binRoot, 'pbpaste')
const pbcopy = join(binRoot, 'pbcopy')
const clipboardOutput = join(root, 'clipboard-output.txt')
const editorOutput = join(root, 'editor-output.txt')
const folderOutput = join(root, 'folder-output.txt')
const wlPaste = join(binRoot, 'wl-paste')
const wlCopy = join(binRoot, 'wl-copy')
const open = join(binRoot, 'open')
const xdgOpen = join(binRoot, 'xdg-open')
const snapshotHelper = join(root, 'snapshot-shared-trees.mjs')
const importedMemory = join(configRoot, 'imported.md')
const importedBefore = 'IMPORTED_TUI_CONTEXT_BEFORE'
const importedAfter = 'IMPORTED_TUI_CONTEXT_AFTER'
const providerRequests = []
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

const provider = createServer(async (request, response) => {
  let requestBody = ''
  for await (const chunk of request) {
    // Drain request before responding so the real adapter lifecycle is tested.
    requestBody += chunk
  }
  let latestText = ''
  try {
    const payload = JSON.parse(requestBody)
    providerRequests.push(payload)
    const latestContent = payload.messages?.at(-1)?.content
    latestText =
      typeof latestContent === 'string'
        ? latestContent
        : JSON.stringify(latestContent ?? '')
  } catch {
    // Invalid provider requests are exercised by the adapter tests.
  }
  const content = latestText.includes('Reply with SIDE only.')
    ? 'SIDE'
    : latestText.includes('reply briefly')
      ? 'TUI_MODEL_OK'
      : latestText.includes('memory reload probe')
        ? 'MEMORY_RELOAD_OK'
        : 'TUI_FAKE_OK'
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
  )
})

try {
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(join(configRoot, 'commands'), { recursive: true }),
    mkdir(join(configRoot, 'agents'), { recursive: true }),
    mkdir(cwd),
    mkdir(movedCwd),
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
    join(configRoot, 'CLAUDE.md'),
    '# Shared user memory\n@imported.md\n',
  )
  await writeFile(importedMemory, `${importedBefore}\n`)
  await writeFile(join(cwd, 'CLAUDE.md'), '# Shared project memory\n')
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
expect_before timeout {
  puts stderr "TUI memory cancel timed out during $phase"
  exit 1
}
spawn -noecho env COLUMNS=100 LINES=32 TERM=xterm-256color PATH=$env(PATH) CLAUDE_CONFIG_DIR=$env(TUI_CANCEL_CONFIG_ROOT) PRAXIS_PROVIDER=openai PRAXIS_API_KEY=fixture-key PRAXIS_MODEL=fixture-model PRAXIS_BASE_URL=$env(TUI_PROVIDER_URL) $env(TUI_NODE) $env(TUI_CLI) --session-id $env(TUI_CANCEL_SESSION_ID) --dangerously-skip-permissions
stty rows 32 columns 100 < $spawn_out(slave,name)
expect -re {Praxis.*Code.*v${expectedVersionPattern}}
exec $env(TUI_NODE) $env(TUI_SNAPSHOT_HELPER) $env(TUI_CANCEL_CONFIG_ROOT) $env(TUI_CANCEL_CWD) $env(TUI_CANCEL_BEFORE)
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
exec $env(TUI_NODE) $env(TUI_SNAPSHOT_HELPER) $env(TUI_CANCEL_CONFIG_ROOT) $env(TUI_CANCEL_CWD) $env(TUI_CANCEL_AFTER)
send "\003"
expect -re {Press Ctrl-C again to exit}
send "\003"
expect eof
exit 0
`
  await execFileAsync('expect', ['-c', cancelProbe], {
    cwd: cancelCwd,
    env: {
      ...process.env,
      CI: 'true',
      PATH: `${binRoot}${delimiter}${process.env.PATH ?? ''}`,
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
  const [cancelBefore, cancelAfter] = await Promise.all(
    [cancelBeforePath, cancelAfterPath].map(async (path) =>
      JSON.parse(await readFile(path, 'utf8')),
    ),
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
expect -re {❯[^\r\n]*\/rev}
send "\033"
expect {
  -re {Review the shared fixture} { puts stderr "slash palette remained open after Escape"; exit 1 }
  -re {❯[^\r\n]*\/rev} {}
}
send "\025"
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
  -re {TUI_MODEL_OK} {}
  timeout { puts stderr "assistant response did not render"; exit 1 }
  eof { puts stderr "Praxis exited before assistant response"; exit 1 }
}
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
set phase "shell mode after cd"
send "!"
expect -re {! for shell mode}
send "pwd"
after 100
send "\r"
expect -re {⎿.*moved-work}
expect -re {TUI_FAKE_OK}
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
after 300
set phase "copy response"
send "/copy"
expect -re {Copy Praxis.*last response}
after 100
send "\r"
expect -re {Copied last response to clipboard}
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
send "\033"
after 100
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
        ...process.env,
        CI: 'true',
        PATH: `${binRoot}${delimiter}${process.env.PATH ?? ''}`,
        TUI_CLI: cli,
        TUI_CLIPBOARD_OUTPUT: clipboardOutput,
        TUI_CONFIG_ROOT: configRoot,
        TUI_EDITOR: editor,
        TUI_EDITOR_OUTPUT: editorOutput,
        TUI_FOLDER_OUTPUT: folderOutput,
        TUI_MOVED_ROOT: movedCwd,
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
  assert.ok(
    transcript.includes(`<bash-stdout>${canonicalMovedCwd}\\n</bash-stdout>`),
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
  assert.match(clipboard, /Praxis Code v/u)
  assert.match(clipboard, /❯ reply briefly/u)
  assert.match(clipboard, /⏺ TUI_FAKE_OK/u)
  assert.match(clipboard, /❯ \/export/u)
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
send "/compact"
expect -re {Clear conversation history.*summary}
send "\r"
expect -re {Compacted.*ctrl\+o.*full summary}
send "\017"
expect -re {TUI_FAKE_OK}
send "\003"
expect -re {Press Ctrl-C again to exit}
send "\003"
expect eof
exit 0
`
  await execFileAsync('expect', ['-c', resumeProbe], {
    cwd: movedCwd,
    env: {
      ...process.env,
      CI: 'true',
      PATH: `${binRoot}${delimiter}${process.env.PATH ?? ''}`,
      TUI_CLI: cli,
      TUI_CONFIG_ROOT: configRoot,
      TUI_NODE: process.execPath,
      TUI_PROVIDER_URL: `http://127.0.0.1:${port}/v1`,
      TUI_SESSION_ID: basename(branchTranscript.file, '.jsonl'),
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
