import { spawn } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, relative, sep } from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'
import { pathToFileURL } from 'node:url'

const probeRoot = await mkdtemp(join(tmpdir(), 'praxis-package-'))
const commandTimeoutMs = 2 * 60 * 1_000
const commandTerminationGraceMs = 1_000
const maxCommandOutputBytes = 4 * 1024 * 1024
const maxPackageBytes = 1024 * 1024
const maxUnpackedBytes = 4 * 1024 * 1024

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32'
    const child = spawn(file, args, {
      ...options,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let stopReason
    let spawnError
    let closeResult
    let escalationComplete = false
    let forceTimer

    const terminate = (signal) => {
      if (detached && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal)
          return
        } catch (error) {
          if (error?.code !== 'ESRCH') throw error
        }
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal)
      }
    }
    const finish = () => {
      if (closeResult === undefined || (stopReason && !escalationComplete)) {
        return
      }
      clearTimeout(timeoutTimer)
      clearTimeout(forceTimer)
      const [code, signal] = closeResult
      if (!spawnError && !stopReason && code === 0) {
        resolve({ stdout, stderr })
        return
      }
      const reason =
        stopReason ??
        (spawnError
          ? String(spawnError)
          : `exited with ${code === null ? `signal ${signal}` : `code ${code}`}`)
      reject(
        new Error(
          `${file} ${args.join(' ')} failed: ${reason}${stderr.trim() ? `\n${stderr.trim()}` : ''}`,
          spawnError ? { cause: spawnError } : undefined,
        ),
      )
    }
    const stop = (reason) => {
      if (stopReason) return
      stopReason = reason
      terminate('SIGTERM')
      forceTimer = setTimeout(() => {
        terminate('SIGKILL')
        escalationComplete = true
        finish()
      }, commandTerminationGraceMs)
    }
    const capture = (target) => (chunk) => {
      const remaining = maxCommandOutputBytes - outputBytes
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining).toString('utf8')
        if (target === 'stdout') stdout += retained
        else stderr += retained
      }
      outputBytes += chunk.length
      if (outputBytes > maxCommandOutputBytes) {
        stop(`output exceeded ${maxCommandOutputBytes} bytes`)
      }
    }
    const timeoutTimer = setTimeout(
      () => stop(`timed out after ${commandTimeoutMs}ms`),
      commandTimeoutMs,
    )

    child.stdout.on('data', capture('stdout'))
    child.stderr.on('data', capture('stderr'))
    child.on('error', (error) => {
      spawnError = error
    })
    child.on('close', (code, signal) => {
      closeResult = [code, signal]
      finish()
    })
  })
}

async function listReleaseFiles(root) {
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile())
        files.push(relative(root, path).split(sep).join('/'))
      else throw new Error(`Unsupported release file type: ${path}`)
    }
  }
  await visit(root)
  return files.sort()
}

function assertPackageContents(files, distFiles) {
  const expected = new Set([
    'LICENSE',
    'README.md',
    'package.json',
    ...distFiles,
  ])
  const allowedDistSuffixes = ['.js', '.js.map', '.d.ts', '.d.ts.map']
  for (const path of distFiles) {
    if (
      !allowedDistSuffixes.some((suffix) => path.endsWith(suffix)) ||
      /\.(?:spec|test)\./u.test(path)
    ) {
      throw new Error(`Unexpected dist release file: ${path}`)
    }
  }
  for (const { path } of files) {
    if (!expected.delete(path)) {
      throw new Error(`Unexpected release package file: ${path}`)
    }
  }
  if (expected.size > 0) {
    throw new Error(
      `Release package is missing: ${[...expected].sort().join(', ')}`,
    )
  }
}

async function expectRejected(action, message) {
  try {
    await action()
  } catch (error) {
    if (String(error).includes(message)) return
    throw error
  }
  throw new Error(`Expected rejection containing ${message}`)
}

try {
  const repositoryRoot = process.cwd()
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
  )
  if (manifest.private === true) {
    throw new Error('Release package must not be private')
  }
  if (manifest.license !== 'MIT') {
    throw new Error(`Unexpected package license: ${String(manifest.license)}`)
  }
  const distFiles = await listReleaseFiles(join(repositoryRoot, 'dist'))
  if (!distFiles.includes('cli.js') || !distFiles.includes('cli.d.ts')) {
    throw new Error('Built release is missing CLI entry files')
  }
  const packagedDistFiles = distFiles.map((path) => `dist/${path}`)

  const packRoot = join(probeRoot, 'pack')
  await mkdir(packRoot, { recursive: true })
  const { stdout: packOutput } = await run(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', packRoot],
    { cwd: repositoryRoot },
  )
  const [packed] = JSON.parse(packOutput)
  if (
    !packed ||
    packed.name !== manifest.name ||
    packed.version !== manifest.version
  ) {
    throw new Error(`Unexpected npm pack result: ${packOutput}`)
  }
  assertPackageContents(packed.files, packagedDistFiles)
  if (packed.size > maxPackageBytes) {
    throw new Error(
      `Release package exceeded ${maxPackageBytes} bytes: ${packed.size}`,
    )
  }
  if (packed.unpackedSize > maxUnpackedBytes) {
    throw new Error(
      `Unpacked release exceeded ${maxUnpackedBytes} bytes: ${packed.unpackedSize}`,
    )
  }

  const tarball = join(packRoot, packed.filename)
  await access(tarball)
  const installRoot = join(probeRoot, 'install')
  await mkdir(installRoot, { recursive: true })
  await writeFile(
    join(installRoot, 'package.json'),
    `${JSON.stringify({ private: true })}\n`,
  )
  await run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      tarball,
    ],
    { cwd: installRoot },
  )

  const installedPackage = join(installRoot, 'node_modules', manifest.name)
  const installedManifest = JSON.parse(
    await readFile(join(installedPackage, 'package.json'), 'utf8'),
  )
  if (installedManifest.version !== manifest.version) {
    throw new Error('Installed tarball version does not match package manifest')
  }
  await access(join(installedPackage, 'dist', 'cli.js'))

  const praxis = join(installRoot, 'node_modules', '.bin', 'praxis')
  const version = await run(praxis, ['--version'], { cwd: installRoot })
  if (version.stdout.trim() !== manifest.version) {
    throw new Error(`Installed CLI returned ${version.stdout.trim()}`)
  }
  const help = await run(praxis, ['--help'], { cwd: installRoot })
  if (!help.stdout.includes('Usage:\n  praxis')) {
    throw new Error('Installed CLI help is unavailable')
  }

  const fakeBin = join(probeRoot, 'bin')
  const configRoot = join(probeRoot, 'claude-config')
  const workDirectory = join(probeRoot, 'work')
  await mkdir(fakeBin, { recursive: true })
  await mkdir(configRoot, { recursive: true })
  await mkdir(workDirectory, { recursive: true })
  await writeFile(
    join(fakeBin, 'claude'),
    "#!/bin/sh\nprintf '2.1.208 (Claude Code)\\n'\n",
    { mode: 0o755 },
  )
  const sessions = await run(praxis, ['sessions', '--json'], {
    cwd: workDirectory,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configRoot,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
    },
  })
  const sessionResult = JSON.parse(sessions.stdout)
  if (
    sessionResult.type !== 'sessions' ||
    !Array.isArray(sessionResult.sessions) ||
    sessionResult.sessions.length !== 0
  ) {
    throw new Error(`Installed CLI session smoke failed: ${sessions.stdout}`)
  }

  const schemaModule = await import(
    pathToFileURL(
      join(installedPackage, 'dist', 'compatibility', 'claude', 'schema.js'),
    ).href
  )
  const sessionModule = await import(
    pathToFileURL(
      join(installedPackage, 'dist', 'application', 'session-service.js'),
    ).href
  )
  const versionMatrix = [
    ['2.1.208', 'read-write'],
    ['2.1.207', 'read-only'],
    ['2.1.209', 'read-only'],
    ['3.0.0', 'read-only'],
  ]
  for (const [claudeVersion, writeMode] of versionMatrix) {
    const adapter = schemaModule.selectClaudeSchemaAdapter(claudeVersion)
    if (adapter.writeMode !== writeMode) {
      throw new Error(
        `Claude ${claudeVersion} resolved ${adapter.writeMode}, expected ${writeMode}`,
      )
    }
    const entry = adapter.parse('{"type":"user","future":true}')
    if (entry.future !== true) {
      throw new Error(`Claude ${claudeVersion} read compatibility failed`)
    }
    const matrixConfigRoot = join(probeRoot, 'matrix', claudeVersion)
    const service = new sessionModule.ClaudeSessionService({
      configRoot: matrixConfigRoot,
      cwd: workDirectory,
      claudeVersion,
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta', delta: 'release matrix response' }
        },
      },
    })
    if (writeMode === 'read-write') {
      const result = await service.run('release matrix prompt')
      await service.fork(result.sessionId)
      const matrixSessions = await service.sessions()
      if (matrixSessions.length !== 2) {
        throw new Error(
          `Claude ${claudeVersion} write/fork matrix created ${matrixSessions.length} sessions`,
        )
      }
      continue
    }
    await expectRejected(
      () => Promise.resolve(adapter.serializeForAppend(entry)),
      'read-only mode',
    )
    await expectRejected(
      () => Promise.resolve(adapter.serializeForFork(entry)),
      'read-only mode',
    )
    await expectRejected(() => service.run('must stay read-only'), 'read-only')
    await expectRejected(() => service.fork('must-not-exist'), 'read-only')
    if ((await service.sessions()).length !== 0) {
      throw new Error(
        `Claude ${claudeVersion} read-only matrix wrote a session`,
      )
    }
  }

  console.log(
    `Praxis ${manifest.version} release package passed: ${packed.files.length} files, ${packed.size} compressed bytes, clean tarball install, CLI smoke, and Claude 2.1.207/2.1.208/2.1.209/3.0.0 write-safety matrix`,
  )
} finally {
  await rm(probeRoot, { recursive: true })
}
