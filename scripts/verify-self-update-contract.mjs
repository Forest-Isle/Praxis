import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

async function run(args) {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], {
      maxBuffer: 1024 * 1024,
    })
    return { code: 0, ...result }
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    }
  }
}

const installHelp = await run(['install', '--help'])
if (
  installHelp.code !== 0 ||
  !installHelp.stdout.includes('Usage: praxis install')
) {
  throw new Error(
    `install help contract failed: ${JSON.stringify(installHelp)}`,
  )
}
const updateHelp = await run(['upgrade', '--help'])
if (
  updateHelp.code !== 0 ||
  !updateHelp.stdout.includes('Usage: praxis update|upgrade')
) {
  throw new Error(`update help contract failed: ${JSON.stringify(updateHelp)}`)
}
const invalid = await run(['install', 'not-a-target'])
if (invalid.code === 0 || !invalid.stderr.includes('install target must be')) {
  throw new Error(`invalid target contract failed: ${JSON.stringify(invalid)}`)
}

console.log('Praxis install/update CLI contract passed.')
