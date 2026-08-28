import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { TextEncoder } from 'node:util'

const interactiveModule = new URL('../dist/cli/interactive.js', import.meta.url)
  .pathname
const childSource = String.raw`
  import {mkdtemp, rm} from 'node:fs/promises'
  import {tmpdir} from 'node:os'
  import {join} from 'node:path'
  import {runInteractive} from ${JSON.stringify(interactiveModule)}

  const root = await mkdtemp(join(tmpdir(), 'praxis-interactive-ansi-'))
  const runtimeSettings = {
    tui: 'fullscreen', autoCompact: false, switchModelsOnFlag: false,
    tips: false, reduceMotion: false, thinking: false, recap: false,
    checkpoints: false, workflows: false, workflowKeywordTriggerEnabled: true,
    workflowSizeGuideline: 'unrestricted', verbose: false, progressBar: false,
    turnDuration: false, permissionMode: 'default', worktreeBaseRef: 'head',
    useAutoModeDuringPlan: false, gitignore: true, copyFullResponse: false,
    defaultToAgentsView: false, leftArrowOpensAgents: false,
    autoUpdatesChannel: 'latest', theme: 'dark', notifChannel: 'none',
    outputStyle: 'default', language: 'default', editor: 'normal',
    askUserQuestionTimeout: 'never', externalEditorContext: false,
    prStatus: false, model: 'default',
  }
  const factory = {
    async createService() {
      return {
        async sessions() {
          return [{sessionId: 'pty-session', status: 'ready', title: 'PTY resumed', cwd: process.cwd(), createdAt: 1, updatedAt: 1}]
        },
        async transcript() {
          return [
            {kind: 'user', text: 'PTY_RESUMED_USER'},
            {kind: 'assistant', text: 'PTY_RESUMED_ASSISTANT'},
          ]
        },
        async agentColor() { return 'blue' },
        slashCommands() { return [] },
        agentDefinitions() { return [] },
        async close() {},
      }
    },
  }
  try {
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    const code = await runInteractive({
      factory, configRoot: root, statePath: join(root, 'state.json'),
      runtimeSettings, display: {version: 'pty-smoke', cwd: process.cwd()},
      resume: {sessionId: 'pty-session'},
    })
    process.stdout.write('INTERACTIVE_EXIT:' + code + '\\n')
    process.exitCode = 0
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  } finally {
    await rm(root, {recursive: true, force: true})
  }
`

const pythonDriver = String.raw`
import fcntl, os, pty, select, signal, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
process = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
output = b''
sent_ctrl_c_count = 0
deadline = time.time() + 10
while time.time() < deadline:
    ready, _, _ = select.select([master], [], [], 0.1)
    if ready:
        try:
            output += os.read(master, 65536)
        except OSError:
            pass
    if sent_ctrl_c_count == 0 and b'\x1b[?1049h' in output and b'PTY_RESUMED_USER' in output and b'PTY_RESUMED_ASSISTANT' in output:
        os.write(master, b'\x03')
        sent_ctrl_c_count = 1
    if sent_ctrl_c_count == 1 and b'Exit Praxis?' in output and b'Enter confirm  Esc cancel' in output:
        os.write(master, b'\x03')
        sent_ctrl_c_count = 2
    if process.poll() is not None:
        break
if process.poll() is None:
    process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
os.close(master)
os.close(slave)
sys.stdout.buffer.write(output)
if sent_ctrl_c_count != 2:
    raise SystemExit('PTY did not observe ANSI/transcript markers and the Ctrl-C exit guard')
if process.returncode != 0:
    raise SystemExit('interactive child exited ' + str(process.returncode))
`

const ansiEnvironment = { ...process.env, TERM: 'xterm-256color' }
delete ansiEnvironment.NO_COLOR

const driver = spawn(
  'python3',
  [
    '-c',
    pythonDriver,
    process.execPath,
    '--input-type=module',
    '-e',
    childSource,
  ],
  {
    cwd: new URL('..', import.meta.url),
    env: ansiEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
let stderr = ''
let stdout = ''
driver.stdout.on('data', (chunk) => {
  stdout += chunk.toString('utf8')
})
driver.stderr.on('data', (chunk) => {
  stderr += chunk.toString('utf8')
})
const [code] = await once(driver, 'close')
if (code !== 0)
  throw new Error(
    `interactive ANSI PTY regression failed (exit ${code}): ${stderr}\nCaptured output: ${JSON.stringify(stdout)}`,
  )

const bytes = new TextEncoder().encode(stdout)
const count = (value) => stdout.split(value).length - 1
if (
  count('\x1b[?1049h') !== 1 ||
  count('\x1b[?1049l') !== 1 ||
  stdout.indexOf('\x1b[?1049h') > stdout.indexOf('\x1b[?1049l')
)
  throw new Error('alternate-screen lifecycle was not exactly one ordered pair')
const cursorHide = '\x1b[?25l'
const cursorShow = '\x1b[?25h'
const cursorHides = []
let cursorPosition = 0
while ((cursorPosition = stdout.indexOf(cursorHide, cursorPosition)) >= 0) {
  cursorHides.push(cursorPosition)
  cursorPosition += cursorHide.length
}
const cursorShows = []
cursorPosition = 0
while ((cursorPosition = stdout.indexOf(cursorShow, cursorPosition)) >= 0) {
  cursorShows.push(cursorPosition)
  cursorPosition += cursorShow.length
}
if (
  cursorHides.length < 1 ||
  cursorShows.length < cursorHides.length ||
  cursorShows.at(-1) < cursorHides.at(-1)
)
  throw new Error('cursor lifecycle did not finish visible')
if (!stdout.includes('\x1b[1m') && !stdout.includes('\x1b[2m'))
  throw new Error('ANSI semantic styling was not emitted')
if (
  !stdout.includes('PTY_RESUMED_USER') ||
  !stdout.includes('PTY_RESUMED_ASSISTANT')
)
  throw new Error('resumed transcript was not rendered')
if (
  !stdout.includes('INTERACTIVE_EXIT:130') ||
  stdout.includes('INTERACTIVE_EXIT:0') ||
  /Error:| at .*\(/u.test(stdout)
)
  throw new Error('interactive exit/error markers were invalid')
if (bytes.byteLength >= 12000)
  throw new Error(
    `interactive ANSI raw-byte budget exceeded (${bytes.byteLength} >= 12000)`,
  )
console.log(
  `Interactive ANSI PTY regression passed (raw bytes: ${bytes.byteLength})`,
)
