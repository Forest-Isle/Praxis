import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { TextEncoder } from 'node:util'

const childSource = String.raw`
  import React, {useEffect, useState} from 'react'
  import {render, Text, useApp} from 'ink'
  import {tuiInkRenderOptions, useTuiPresentationEnvironment} from ${JSON.stringify(new URL('../dist/cli/tui/presentation-environment.js', import.meta.url).pathname)}

  function App() {
    const {exit} = useApp()
    const environment = useTuiPresentationEnvironment({renderer: 'fullscreen', screenReader: false})
    const [burst, setBurst] = useState(0)
    const [done, setDone] = useState(false)
    React.useEffect(() => {
      process.stdin.setRawMode?.(true)
      process.stdin.resume()
      process.stdin.on('data', (chunk) => {
        const input = chunk.toString()
        if (input.includes('q')) setDone(true)
      })
    }, [])
    useEffect(() => {
      let count = 0
      const timer = setInterval(() => {
        count += 1
        setBurst(count)
        if (count >= 48) clearInterval(timer)
      }, 1)
      return () => clearInterval(timer)
    }, [])
    React.useEffect(() => {
      if (done) exit()
    }, [done, exit])
    const final = environment.viewport.columns === 80 && environment.viewport.rows === 24 && burst >= 48
    React.useEffect(() => {
      if (final) exit()
    }, [final, exit])
    const lines = [
      final ? 'FINAL_80x24' : 'INITIAL_120x40',
      final ? 'CURRENT_SENTINEL' : 'STALE_SENTINEL',
      final ? 'FRAME_FINAL' : 'FRAME_LONG',
      ['COMMITTED_FRAME:', burst, ':', environment.viewport.columns, 'x', environment.viewport.rows ?? 'unknown'].join(''),
    ]
    return React.createElement(Text, null, lines.join('\n'))
  }

  render(React.createElement(App), {
    ...tuiInkRenderOptions('fullscreen', false),
    interactive: true,
    exitOnCtrlC: false,
  })
`

const pythonDriver = String.raw`
import fcntl, os, pty, select, signal, struct, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
process = __import__('subprocess').Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
output = b''
sent_resize = False
sent_quit = False
deadline = time.time() + 10
while process.poll() is None and time.time() < deadline:
    ready, _, _ = select.select([master], [], [], 0.1)
    if not ready:
        continue
    try:
        chunk = os.read(master, 65536)
    except OSError:
        break
    output += chunk
    if not sent_resize and b'INITIAL_120x40' in output and b'FRAME_LONG' in output:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        os.kill(process.pid, signal.SIGWINCH)
        sent_resize = True
    if sent_resize and not sent_quit and b'FINAL_80x24' in output and b'FRAME_FINAL' in output:
        sent_quit = True
if process.poll() is None:
    process.terminate()
    process.wait(timeout=2)
os.close(slave)
sys.stdout.buffer.write(output)
if not sent_resize or not sent_quit:
    raise SystemExit('PTY did not observe both fullscreen frames')
if b'STALE_SENTINEL' not in output or b'FINAL_80x24' not in output:
    raise SystemExit('PTY output did not contain the expected frame markers')
if b'\x1b[2K' not in output:
    raise SystemExit('fullscreen redraw did not emit erase-line ANSI sequences')
if b'\x1b[?1049h' not in output or b'\x1b[?1049l' not in output:
    raise SystemExit('fullscreen alternate-screen lifecycle was incomplete')
if output.count(b'\x1b[?2026h') != output.count(b'\x1b[?2026l'):
    raise SystemExit('fullscreen synchronized output was not closed')
sync_begin = b'\x1b[?2026h'
sync_end = b'\x1b[?2026l'
frames = []
cursor = 0
while True:
    start = output.find(sync_begin, cursor)
    if start < 0:
        break
    end = output.find(sync_end, start + len(sync_begin))
    if end < 0:
        break
    frames.append(output[start:end + len(sync_end)])
    cursor = end + len(sync_end)
if not frames:
    raise SystemExit('fullscreen output did not contain a synchronized frame')
final_frame = frames[-1]
import re
ansi_pattern = re.compile(rb'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))')
semantic = ansi_pattern.sub(b'', final_frame).replace(b'\r\n', b'\n').replace(b'\r', b'\n')
semantic_lines = [line for line in semantic.split(b'\n') if line.strip()]
expected_lines = [b'FINAL_80x24', b'CURRENT_SENTINEL', b'FRAME_FINAL', b'COMMITTED_FRAME:48:80x24']
if semantic_lines != expected_lines:
    raise SystemExit(f'fullscreen final semantic frame mismatch: {semantic_lines!r}')
if output.count(b'\x1b[?1049h') != 1 or output.count(b'\x1b[?1049l') != 1:
    raise SystemExit('fullscreen alternate-screen lifecycle was not exactly one enter/leave pair')
if output.find(b'\x1b[?1049h') > output.find(b'\x1b[?1049l'):
    raise SystemExit('fullscreen alternate-screen lifecycle order was invalid')
frame_count = output.count(b'COMMITTED_FRAME:')
if frame_count > 24:
    raise SystemExit(f'fullscreen frame budget exceeded ({frame_count} > 24)')
if len(output) > 18000:
    raise SystemExit(f'fullscreen raw-byte budget exceeded ({len(output)} > 18000)')
`

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
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
let stderr = ''
let stdout = ''
driver.stdout.setEncoding('utf8')
driver.stdout.on('data', (chunk) => {
  stdout += chunk
})
driver.stderr.setEncoding('utf8')
driver.stderr.on('data', (chunk) => {
  stderr += chunk
})
const [code] = await once(driver, 'close')
if (code !== 0) {
  throw new Error(
    `fullscreen PTY regression failed (exit ${code}): ${stderr}\nCaptured output: ${JSON.stringify(stdout)}`,
  )
}
const committedFrameCount = (stdout.match(/COMMITTED_FRAME:/gu) ?? []).length
console.log(
  `Fullscreen PTY presentation environment regression passed (committed frames: ${committedFrameCount}, raw bytes: ${new TextEncoder().encode(stdout).byteLength})`,
)
