import { spawn } from 'node:child_process'
import { once } from 'node:events'

const childSource = String.raw`
  import React, {useState} from 'react'
  import {render, Text} from 'ink'
  import {fullscreenInkRenderOptions} from ${JSON.stringify(new URL('../dist/cli/tui/fullscreen-renderer.js', import.meta.url).pathname)}

  function App() {
    const [short, setShort] = useState(false)
    const [done, setDone] = useState(false)
    React.useEffect(() => {
      process.stdin.setRawMode?.(true)
      process.stdin.resume()
      process.stdin.on('data', (chunk) => {
        const input = chunk.toString()
        if (input.includes('s')) setShort(true)
        if (input.includes('q')) setDone(true)
      })
    }, [])
    React.useEffect(() => {
      if (done) process.exit(0)
    }, [done])
    const lines = short
      ? ['CURRENT_SENTINEL', 'FRAME_SHORT']
      : ['STALE_SENTINEL', 'CURRENT_SENTINEL', 'FRAME_LONG']
    return React.createElement(Text, null, lines.join('\n'))
  }

  render(React.createElement(App), {
    ...fullscreenInkRenderOptions('fullscreen', false),
    interactive: true,
    exitOnCtrlC: false,
  })
`

const pythonDriver = String.raw`
import fcntl, os, pty, select, struct, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
process = __import__('subprocess').Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
output = b''
sent_shrink = False
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
    if not sent_shrink and b'STALE_SENTINEL' in output and b'FRAME_LONG' in output:
        os.write(master, b's')
        sent_shrink = True
    if sent_shrink and not sent_quit and b'FRAME_SHORT' in output:
        os.write(master, b'q')
        sent_quit = True
if process.poll() is None:
    process.terminate()
    process.wait(timeout=2)
sys.stdout.buffer.write(output)
if not sent_shrink or not sent_quit:
    raise SystemExit('PTY did not observe both fullscreen frames')
if b'STALE_SENTINEL' not in output or b'FRAME_SHORT' not in output:
    raise SystemExit('PTY output did not contain the expected frame markers')
if b'\x1b[2K' not in output:
    raise SystemExit('fullscreen redraw did not emit erase-line ANSI sequences')
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
driver.stderr.setEncoding('utf8')
driver.stderr.on('data', (chunk) => {
  stderr += chunk
})
const [code] = await once(driver, 'close')
if (code !== 0) {
  throw new Error(`fullscreen PTY regression failed (exit ${code}): ${stderr}`)
}
console.log('Fullscreen PTY redraw regression passed')
