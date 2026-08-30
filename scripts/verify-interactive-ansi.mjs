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
  const lane = process.env.PRAXIS_PTY_LANE
  const root = await mkdtemp(join(tmpdir(), 'praxis-interactive-pty-'))
  const runtimeSettings = {tui:'fullscreen',autoCompact:false,switchModelsOnFlag:false,tips:false,reduceMotion:false,thinking:false,recap:false,checkpoints:false,workflows:false,workflowKeywordTriggerEnabled:true,workflowSizeGuideline:'unrestricted',verbose:false,progressBar:false,turnDuration:false,permissionMode:'default',worktreeBaseRef:'head',useAutoModeDuringPlan:false,gitignore:true,copyFullResponse:false,defaultToAgentsView:false,leftArrowOpensAgents:false,autoUpdatesChannel:'latest',theme:'dark',notifChannel:'none',outputStyle:'default',language:'default',editor:'normal',askUserQuestionTimeout:'never',externalEditorContext:false,prStatus:false,model:'default'}
  let injected = false
  const originalWrite = process.stdout.write.bind(process.stdout)
  if (lane === 'fallback') process.stdout.write = (chunk, ...args) => { const text = typeof chunk === 'string' ? chunk : chunk.toString(); if (!injected && text.includes('\x1b[2K')) { injected = true; throw new Error('injected ANSI draw failure') }; return originalWrite(chunk, ...args) }
  const user = lane === 'fallback' ? 'PTY_FALLBACK_USER' : 'PTY_RESUMED_USER'
  const assistant = lane === 'fallback' ? 'PTY_FALLBACK_ASSISTANT' : 'PTY_RESUMED_ASSISTANT'
  const factory = { async createService({eventSink, approveTool}) { return { async sessions() { return [{sessionId:'pty-session',status:'ready',title:'PTY resumed',cwd:process.cwd(),createdAt:1,updatedAt:1}] }, async transcript() { return [{kind:'user',text:user},{kind:'assistant',text:assistant}] }, async resume(sessionId) { const call={id:'pty-permission',name:'Bash',input:{command:'printf PTY_PERMISSION'}}; await approveTool(call,call,{behavior:'ask',reason:'Command requires confirmation.'}); for (let i=0;i<120;i++) eventSink({type:'text-delta',delta:'PTY_STREAM_'+i+' '}); await new Promise(resolve=>setTimeout(resolve,190)); return {sessionId,text:'PTY_STREAM_FINAL',usage:{inputTokens:1,outputTokens:120}} }, async run() { throw new Error('unused') }, async fork() { throw new Error('unused') }, async close() {}, slashCommands() { return [] }, agentDefinitions() { return [] }, async agentColor() { return 'blue' } } } }
  try { process.stdin.setRawMode?.(true); process.stdin.resume(); const code = await runInteractive({factory,configRoot:root,statePath:join(root,'state.json'),runtimeSettings,display:{version:'pty-smoke',cwd:process.cwd()},resume:{sessionId:'pty-session'}}); process.stdout.write('INTERACTIVE_EXIT:'+code+'\n'); process.exitCode=0 } catch (error) { process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode=1 } finally { if (lane === 'fallback') { originalWrite('\x1b[?25h'); originalWrite('PTY_FALLBACK_INJECTED:'+injected+'\n') }; await rm(root,{recursive:true,force:true}) }
`

const pythonDriver = String.raw`
import fcntl, os, pty, select, signal, struct, subprocess, sys, termios, time
lane=os.environ.get('PRAXIS_PTY_LANE'); master,slave=pty.openpty(); fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',30,100,0,0)); process=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave); output=b''; sent_prompt=prompt_submitted=down_sent=up_sent=sent_permission=resized=sent_exit=0; prompt_offset=down_offset=up_offset=resize_offset=None; deadline=time.time()+30
def has(*markers): return all(marker in output for marker in markers)
while time.time()<deadline:
    ready,_,_=select.select([master],[],[],0.05)
    if ready:
        try: output+=os.read(master,65536)
        except OSError: pass
    if lane=='fallback':
        if not sent_exit and has(b'PTY_FALLBACK_USER',b'PTY_FALLBACK_ASSISTANT',b'\xe2\x9d\xaf'): os.write(master,b'\x03'); sent_exit=1
        if sent_exit==1 and b'Exit Praxis?' in output and b'Enter confirm  Esc cancel' in output: os.write(master,b'\x03'); sent_exit=2
    else:
        if not sent_prompt and has(b'PTY_RESUMED_USER',b'PTY_RESUMED_ASSISTANT',b'\xe2\x9d\xaf',b'ready'): os.write(master,b'PTY prompt'); prompt_offset=len(output); sent_prompt=1
        if sent_prompt and not prompt_submitted and len(output)>prompt_offset and b'PTY prompt' in output[prompt_offset:]: os.write(master,b'\r'); prompt_submitted=1
        if prompt_submitted and not down_sent and has(b'Allow once',b'Deny',b'Enter confirm  Esc cancel'): os.write(master,b'\x1b[B'); down_offset=len(output); down_sent=1
        if down_sent and not up_sent and b'Allow and don' in output[down_offset:]: os.write(master,b'\x1b[A'); up_offset=len(output); up_sent=1
        if up_sent and not sent_permission and b'Allow once' in output[up_offset:]: os.write(master,b'\r'); sent_permission=1
        if sent_permission and not resized and b'PTY_STREAM_' in output: fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',20,60,0,0)); os.kill(process.pid,signal.SIGWINCH); resize_offset=len(output); resized=1
        if resized and not sent_exit and b'PTY_STREAM_FINAL' in output: os.write(master,b'\x03'); sent_exit=1
        if sent_exit==1 and b'Exit Praxis?' in output and b'Enter confirm  Esc cancel' in output: os.write(master,b'\x03'); sent_exit=2
    if process.poll() is not None: break
if process.poll() is None:
    process.kill()
    try: process.wait(timeout=2)
    except subprocess.TimeoutExpired: pass
os.close(master); os.close(slave); sys.stdout.buffer.write(output)
if lane=='fallback' and sent_exit!=2: raise SystemExit('fallback lane missed transcript or Ctrl-C exit guard')
if lane!='fallback' and (sent_prompt!=1 or sent_permission!=1 or resized!=1 or sent_exit!=2): raise SystemExit('ANSI lane missed permission/stream/resize or Ctrl-C exit guard')
if process.returncode!=0: raise SystemExit('interactive child exited '+str(process.returncode))
if lane!='fallback' and resize_offset is not None and b'\x1b[2K' not in output[resize_offset:]: raise SystemExit('ANSI lane emitted no erase/redraw after resize')
`

const ansiEnvironment = { ...process.env, TERM: 'xterm-256color' }
delete ansiEnvironment.NO_COLOR
async function runLane(lane) {
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
      env: { ...ansiEnvironment, PRAXIS_PTY_LANE: lane },
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
      `${lane} PTY failed (exit ${code}): ${stderr}\nCaptured output: ${JSON.stringify(stdout)}`,
    )
  return stdout
}
function assertLifecycle(stdout, budget, markers) {
  const count = (value) => stdout.split(value).length - 1
  if (
    count('\x1b[?1049h') !== 1 ||
    count('\x1b[?1049l') !== 1 ||
    stdout.indexOf('\x1b[?1049h') > stdout.indexOf('\x1b[?1049l')
  )
    throw new Error(
      'alternate-screen lifecycle was not exactly one ordered pair',
    )
  const hides = count('\x1b[?25l'),
    shows = count('\x1b[?25h')
  if (
    !hides ||
    !shows ||
    stdout.lastIndexOf('\x1b[?25h') < stdout.lastIndexOf('\x1b[?25l')
  )
    throw new Error(
      `cursor lifecycle did not finish visible (hides=${hides}, shows=${shows})`,
    )
  for (const marker of markers)
    if (!stdout.includes(marker)) throw new Error('missing marker ' + marker)
  if (
    !stdout.includes('INTERACTIVE_EXIT:130') ||
    /Error:| at .*\(/u.test(stdout)
  )
    throw new Error('interactive exit/error markers were invalid')
  const bytes = new TextEncoder().encode(stdout).byteLength
  if (bytes > budget)
    throw new Error(`raw-byte budget exceeded (${bytes} > ${budget})`)
  return { bytes, redraws: count('\x1b[2K') }
}
const ansiOutput = await runLane('ansi')
const ansi = assertLifecycle(ansiOutput, 24000, [
  'PTY_RESUMED_USER',
  'PTY_RESUMED_ASSISTANT',
  'Allow once',
  'Allow once',
  'Deny',
  'PTY_STREAM_0',
  'PTY_STREAM_FINAL',
])
if (!ansiOutput.includes('\x1b[1m') && !ansiOutput.includes('\x1b[2m'))
  throw new Error('ANSI semantic styling was not emitted')
if (!ansiOutput.includes('\x1b[2K'))
  throw new Error('ANSI post-resize redraw missing')
const fallbackOutput = await runLane('fallback')
const fallback = assertLifecycle(fallbackOutput, 16000, [
  'PTY_FALLBACK_USER',
  'PTY_FALLBACK_ASSISTANT',
  '❯',
  'PTY_FALLBACK_INJECTED:true',
])
console.log(
  `Interactive PTY lanes passed (ansi bytes: ${ansi.bytes}, ansi redraws: ${ansi.redraws}, fallback bytes: ${fallback.bytes})`,
)
await import('./verify-tui-screen-mouse.mjs')
