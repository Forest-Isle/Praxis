import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-native-package-'))

async function run(command, args, options = {}) {
  const result = await exec(command, args, {
    ...options,
    maxBuffer: 16 * 1024 * 1024,
  })
  return result.stdout
}

try {
  const packDirectory = join(root, 'pack')
  const installDirectory = join(root, 'install')
  const nativeHome = join(root, 'native-home')
  const cwd = join(root, 'project')
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(installDirectory, { recursive: true }),
    mkdir(cwd, { recursive: true }),
  ])

  const packed = JSON.parse(
    await run('npm', ['pack', '--json', '--pack-destination', packDirectory], {
      cwd: process.cwd(),
    }),
  )[0]
  if (!packed?.filename) throw new Error('npm pack returned no tarball')
  const tarball = join(packDirectory, packed.filename)
  await writeFile(join(installDirectory, 'package.json'), '{"private":true}\n')
  await run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
    {
      cwd: installDirectory,
    },
  )

  const packageRoot = join(installDirectory, 'node_modules', 'praxis-agent')
  const manifest = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  )
  const cli = join(installDirectory, 'node_modules', '.bin', 'praxis')
  const environment = {
    ...process.env,
    PRAXIS_HOME: nativeHome,
    PRAXIS_DATA_PLANE: 'native',
  }
  const version = (
    await run(cli, ['--version'], { cwd, env: environment })
  ).trim()
  if (version !== manifest.version)
    throw new Error(`version mismatch: ${version}`)
  const help = await run(cli, ['--help'], { cwd, env: environment })
  if (!help.includes('Usage:\n  praxis'))
    throw new Error('native help unavailable')

  const sessions = JSON.parse(
    await run(cli, ['sessions', '--json'], { cwd, env: environment }),
  )
  if (sessions.type !== 'sessions' || !Array.isArray(sessions.sessions)) {
    throw new Error(`native session list failed: ${JSON.stringify(sessions)}`)
  }
  console.log(
    `Native release package passed: ${packed.filename}, ${version}, native session listing`,
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
