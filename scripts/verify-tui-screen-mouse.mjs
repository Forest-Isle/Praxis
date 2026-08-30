import { spawn } from 'node:child_process'
import { once } from 'node:events'

const interactiveModule = new URL('../dist/cli/interactive.js', import.meta.url)
  .pathname
const childSource = String.raw`
  import {mkdtemp, rm} from 'node:fs/promises'
  import {tmpdir} from 'node:os'
  import {join} from 'node:path'
  import {runInteractive} from ${JSON.stringify(interactiveModule)}
  const root = await mkdtemp(join(tmpdir(), 'praxis-tui-mouse-'))
  const settings = {tui:'fullscreen',autoCompact:false,switchModelsOnFlag:false,tips:false,reduceMotion:false,thinking:false,recap:false,checkpoints:false,workflows:false,workflowKeywordTriggerEnabled:true,workflowSizeGuideline:'unrestricted',verbose:true,progressBar:false,turnDuration:false,permissionMode:'default',worktreeBaseRef:'head',useAutoModeDuringPlan:false,gitignore:true,copyFullResponse:false,defaultToAgentsView:false,leftArrowOpensAgents:false,autoUpdatesChannel:'latest',theme:'dark',notifChannel:'none',outputStyle:'default',language:'default',editor:'normal',askUserQuestionTimeout:'never',externalEditorContext:false,prStatus:false,model:'default'}
  const history = [{kind:'user',text:'MOUSE_FIXTURE_PROMPT'},{kind:'assistant',text:Array.from({length:120},(_,i)=>'MOUSE_FIXTURE_LINE_'+String(i).padStart(3,'0')).join('\n')}]
  const factory = {async createService() { return {async sessions(){return [{sessionId:'mouse-session',status:'ready',title:'Mouse',cwd:process.cwd(),createdAt:1,updatedAt:1}]},async transcript(){return history},async run(){throw new Error('unused')},async resume(){throw new Error('unused')},async fork(){throw new Error('unused')},async close(){},slashCommands(){return []},agentDefinitions(){return []}} }}
  try { process.stdin.setRawMode?.(true); process.stdin.resume(); await runInteractive({factory,configRoot:root,statePath:join(root,'state.json'),runtimeSettings:settings,display:{version:'mouse-test',cwd:process.cwd()},resume:{sessionId:'mouse-session'}}) } finally { await rm(root,{recursive:true,force:true}) }
`

const driver = String.raw`
import base64, fcntl, os, pty, re, select, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
process = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
output = b''
def read_for(seconds):
    global output
    deadline = time.time() + seconds
    while time.time() < deadline:
        ready, _, _ = select.select([master], [], [], 0.03)
        if not ready: continue
        try: output += os.read(master, 65536)
        except OSError: break
def wait_for(marker, timeout=10):
    deadline = time.time() + timeout
    while marker not in output and time.time() < deadline: read_for(0.05)
    return marker in output
read_for(2.0)
failures = []
if not wait_for(b'\x1b[?1049h'): failures.append('startup marker missing')
if not all(mode in output for mode in (b'\x1b[?1000h', b'\x1b[?1002h', b'\x1b[?1003h', b'\x1b[?1006h')): failures.append('mouse tracking was not enabled')
os.write(master, b'DRAFT_SENTINEL')
if not wait_for(b'DRAFT_SENTINEL', 3): failures.append('draft marker missing')
before = len(output); os.write(master, b'\x0c'); read_for(0.6)
if b'\x1b[2J' not in output[before:]: failures.append('Ctrl-L emitted no clear')
if b'DRAFT_SENTINEL' not in output[before:]: failures.append('clear did not redraw the draft')
for _ in range(40): os.write(master, b'\x15'); read_for(0.025)
read_for(0.4)
if b'MOUSE_FIXTURE_LINE_000' not in output: failures.append('keyboard scrolling did not reach oldest row')
anchor_matches = re.findall(rb'\x1b\[(\d+);1H\x1b\[2KMOUSE_FIXTURE_LINE_00\d+', output)
anchor_row = int(anchor_matches[-1]) if anchor_matches else 5
mouse_start = len(output)
os.write(master, ('\x1b[<0;5;'+str(anchor_row)+'M').encode()); read_for(0.1)
for _ in range(12): os.write(master, b'\x1b[<32;5;23M')
read_for(0.2)
for _ in range(12): os.write(master, b'\x1b[<32;5;23M')
read_for(0.9)
os.write(master, b'\x1b[<0;5;23m'); read_for(0.4)
mouse_output = output[mouse_start:]
if not any(('MOUSE_FIXTURE_LINE_'+str(i).zfill(3)).encode() in mouse_output for i in range(10, 40)): failures.append('edge drag did not redraw a newly exposed newer row')
osc = re.findall(b'\x1b\\]52;c;([A-Za-z0-9+/=]+)\x07', mouse_output)
if len(osc) != 1: failures.append('selection emitted '+str(len(osc))+' OSC 52 writes instead of one')
decoded = [base64.b64decode(item).decode('utf8', 'replace') for item in osc]
candidates = []
for item in decoded:
    ordinals = [int(value) for value in re.findall(r'MOUSE_FIXTURE_LINE_(\d{3})', item)]
    if ordinals and min(ordinals) < 10 and max(ordinals) >= 10 and ordinals == list(range(min(ordinals), max(ordinals) + 1)): candidates.append(ordinals)
if not candidates: failures.append('selection did not copy a contiguous range across the viewport boundary')
os.write(master, b'\x03')
if not wait_for(b'Exit Praxis?', 3): failures.append('first Ctrl-C did not open exit confirmation')
else: os.write(master, b'\x03')
if not wait_for(b'\x1b[?1049l', 5): failures.append('second Ctrl-C did not exit through the confirmation path')
if process.poll() is None:
    try: process.wait(timeout=5)
    except subprocess.TimeoutExpired: failures.append('interactive child did not terminate after second Ctrl-C')
if process.returncode is not None and process.returncode != 0: failures.append('interactive child exited '+str(process.returncode))
for mode in (b'1000', b'1002', b'1003', b'1006'):
    if output.count(b'\x1b[?'+mode+b'h') != 1 or output.count(b'\x1b[?'+mode+b'l') != 1: failures.append('mouse mode lifecycle mismatch for '+mode.decode())
if output.count(b'\x1b[?1049h') != 1 or output.count(b'\x1b[?1049l') != 1: failures.append('alternate screen lifecycle mismatch')
if process.poll() is None: process.kill(); process.wait(timeout=2)
os.close(master); os.close(slave)
if failures: raise SystemExit('; '.join(failures))
print('TUI screen/mouse PTY lane passed')
`

const child = spawn(
  'python3',
  ['-c', driver, process.execPath, '--input-type=module', '-e', childSource],
  {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
let stderr = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  stderr += chunk
})
const [code] = await once(child, 'close')
if (code !== 0) throw new Error(stderr.trim() || `PTY lane exited ${code}`)
