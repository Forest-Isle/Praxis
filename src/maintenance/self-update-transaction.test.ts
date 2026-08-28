import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import { runSelfUpdate } from './self-update.js'
import {
  checksum,
  generateLauncherSource,
  runSelfUpdateTransaction,
  type SelfUpdateLayout,
  type TransactionRunner,
} from './self-update-transaction.js'

const execFileAsync = promisify(execFile)
const packageName = 'praxis-agent'
const oldVersion = '1.0.0'
const targetVersion = '2.0.0'

interface Fixture {
  root: string
  layout: SelfUpdateLayout
  oldManifest: string
  oldCli: string
  targetBytes: Buffer
  calls: Array<{ executable: string; args: readonly string[] }>
  run: TransactionRunner
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-update-transaction-'))
  const prefix = join(root, 'prefix')
  const modules = join(prefix, 'lib', 'node_modules')
  const packageRoot = join(modules, packageName)
  const binPath = join(prefix, 'bin', 'praxis')
  await mkdir(join(packageRoot, 'dist'), { recursive: true })
  await mkdir(dirname(binPath), { recursive: true })
  const oldManifest = JSON.stringify({ name: packageName, version: oldVersion })
  const oldCli =
    "export async function run(argv) { if (argv[0] === '--version') console.log('1.0.0'); return 0 }\n"
  await writeFile(join(packageRoot, 'package.json'), oldManifest)
  await writeFile(join(packageRoot, 'dist', 'cli.js'), oldCli)
  await symlink(join(packageRoot, 'dist', 'cli.js'), binPath)

  const targetBytes = Buffer.from(`deterministic-${targetVersion}`)
  const sums = checksum(targetBytes)
  const calls: Fixture['calls'] = []
  const run: TransactionRunner = async (executable, args) => {
    calls.push({ executable, args: [...args] })
    if (
      executable === 'npm' &&
      args[0] === 'view' &&
      args[1] === `${packageName}@${targetVersion}` &&
      args[2] === 'version' &&
      args[3] === 'dist' &&
      args[4] === '--json'
    ) {
      return {
        stdout: JSON.stringify({
          version: targetVersion,
          dist: {
            tarball: 'https://registry.example/praxis-agent.tgz',
            integrity: sums.sha512,
            shasum: sums.sha1,
          },
        }),
        stderr: '',
      }
    }
    if (
      executable === 'npm' &&
      args[0] === 'pack' &&
      args[1] === `${packageName}@${targetVersion}`
    ) {
      if (
        args[2] !== '--ignore-scripts' ||
        args[3] !== '--json' ||
        args[4] !== '--pack-destination'
      )
        throw new Error('unexpected pack argv')
      const destination = args[args.indexOf('--pack-destination') + 1]
      if (!destination) throw new Error('missing pack destination')
      await mkdir(destination, { recursive: true })
      const filename = `${packageName}-${targetVersion}.tgz`
      await writeFile(join(destination, filename), targetBytes)
      return {
        stdout: JSON.stringify([
          {
            name: packageName,
            version: targetVersion,
            filename,
            integrity: sums.sha512,
            shasum: sums.sha1,
          },
        ]),
        stderr: '',
      }
    }
    if (executable === 'npm' && args[0] === 'install') {
      const prefixIndex = args.indexOf('--prefix')
      if (
        args[1] !== '--global' ||
        prefixIndex !== 2 ||
        args[4] !== '--no-fund' ||
        args[5] !== '--no-audit' ||
        args[6] !== '--ignore-scripts' ||
        args.length !== 8
      )
        throw new Error('unexpected install argv')
      const stagingPrefix = args[prefixIndex + 1]
      if (!stagingPrefix) throw new Error('missing install prefix')
      const candidate = join(stagingPrefix, 'lib', 'node_modules', packageName)
      await mkdir(join(candidate, 'dist'), { recursive: true })
      await writeFile(
        join(candidate, 'package.json'),
        JSON.stringify({ name: packageName, version: targetVersion }),
      )
      await writeFile(join(candidate, 'dist', 'cli.js'), 'candidate cli')
      return { stdout: '', stderr: '' }
    }
    if (executable === process.execPath && args[1] === '--version') {
      return { stdout: `${targetVersion}\n`, stderr: '' }
    }
    throw new Error(`unexpected runner call: ${executable} ${args.join(' ')}`)
  }
  return {
    root,
    layout: {
      packageRoot,
      globalNodeModulesRoot: modules,
      globalPrefix: prefix,
      binPath,
    },
    oldManifest,
    oldCli,
    targetBytes,
    calls,
    run,
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function assertNoArtifacts(fixture: Fixture) {
  const { packageRoot } = fixture.layout
  expect(await exists(`${packageRoot}.update.lock`)).toBe(false)
  expect(await exists(`${packageRoot}.update.journal`)).toBe(false)
  const siblings = await readdir(dirname(packageRoot))
  expect(siblings.filter((name) => name.startsWith('.praxis-update-'))).toEqual(
    [],
  )
  expect(
    siblings.filter((name) => name.startsWith(`${packageName}.update-backup-`)),
  ).toEqual([])
}

async function runTransaction(fixture: Fixture, target = targetVersion) {
  return runSelfUpdateTransaction({
    packageName,
    target,
    force: false,
    npmExecutable: 'npm',
    timeoutMs: 10_000,
    layout: fixture.layout,
    run: fixture.run,
  })
}

describe('transactional self-update', () => {
  it('verifies staging, swaps the root, installs the launcher, and preserves the logical command', async () => {
    const fixture = await makeFixture()
    try {
      const result = await runSelfUpdate({
        operation: 'install',
        target: targetVersion,
        npmExecutable: 'npm',
        layout: fixture.layout,
        run: fixture.run,
      })
      expect(result).toMatchObject({
        type: 'self-update',
        operation: 'install',
        package: packageName,
        target: targetVersion,
        force: false,
        output: 'completed',
        command: [
          'npm',
          'install',
          '--global',
          '--no-fund',
          '--no-audit',
          '--ignore-scripts',
          `${packageName}@${targetVersion}`,
        ],
      })
      expect(
        JSON.parse(
          await readFile(
            join(fixture.layout.packageRoot, 'package.json'),
            'utf8',
          ),
        ),
      ).toEqual({
        name: packageName,
        version: targetVersion,
      })
      expect(await readlink(fixture.layout.binPath)).toBe(
        `${fixture.layout.packageRoot}.launcher.mjs`,
      )
      expect(
        fixture.calls.filter((call) => call.args[0] === 'view'),
      ).toHaveLength(1)
      expect(
        fixture.calls.filter((call) => call.args[0] === 'pack'),
      ).toHaveLength(1)
      expect(
        fixture.calls.filter((call) => call.args[0] === 'install'),
      ).toHaveLength(1)
      expect(
        fixture.calls.filter((call) => call.executable === process.execPath),
      ).toHaveLength(2)
      expect(fixture.calls.slice(0, 3).map((call) => call.args[0])).toEqual([
        'view',
        'pack',
        'install',
      ])
      expect(fixture.calls[3]?.args[1]).toBe('--version')
      expect(fixture.calls[4]?.args).toEqual([
        join(fixture.layout.packageRoot, 'dist', 'cli.js'),
        '--version',
      ])
      await assertNoArtifacts(fixture)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects corrupt tarball bytes before staged install or root mutation', async () => {
    const fixture = await makeFixture()
    const originalRun = fixture.run
    fixture.run = async (executable, args, options) => {
      if (args[0] === 'pack') {
        const result = await originalRun(executable, args, options)
        const destination = args[args.indexOf('--pack-destination') + 1]
        if (!destination) throw new Error('missing pack destination')
        await writeFile(
          join(destination, `${packageName}-${targetVersion}.tgz`),
          'corrupt',
        )
        return result
      }
      return originalRun(executable, args, options)
    }
    try {
      await expect(runTransaction(fixture)).rejects.toThrow(
        'package integrity/checksum mismatch',
      )
      expect(fixture.calls.some((call) => call.args[0] === 'install')).toBe(
        false,
      )
      expect(
        JSON.parse(
          await readFile(
            join(fixture.layout.packageRoot, 'package.json'),
            'utf8',
          ),
        ),
      ).toEqual({
        name: packageName,
        version: oldVersion,
      })
      await assertNoArtifacts(fixture)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects an invalid current manifest before registry or staging work', async () => {
    const fixture = await makeFixture()
    try {
      await writeFile(
        join(fixture.layout.packageRoot, 'package.json'),
        JSON.stringify({ name: packageName, version: 'not-semver' }),
      )
      await expect(runTransaction(fixture)).rejects.toThrow(
        'staged package validation failed',
      )
      expect(fixture.calls).toEqual([])
      expect(
        JSON.parse(
          await readFile(
            join(fixture.layout.packageRoot, 'package.json'),
            'utf8',
          ),
        ),
      ).toEqual({ name: packageName, version: 'not-semver' })
      await assertNoArtifacts(fixture)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a concurrent updater before registry or staging work', async () => {
    const fixture = await makeFixture()
    let viewed!: () => void
    let release!: () => void
    const viewSeen = new Promise<void>((resolve) => {
      viewed = resolve
    })
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalRun = fixture.run
    let first = true
    fixture.run = async (executable, args, options) => {
      if (first && args[0] === 'view') {
        first = false
        viewed()
        await hold
      }
      return originalRun(executable, args, options)
    }
    try {
      const firstUpdate = runTransaction(fixture)
      await viewSeen
      const callsBeforeSecond = fixture.calls.length
      await expect(runTransaction(fixture)).rejects.toThrow(
        'Praxis update already in progress',
      )
      expect(fixture.calls.slice(callsBeforeSecond)).toEqual([])
      release()
      await expect(firstUpdate).resolves.toEqual({ output: 'completed' })
      await assertNoArtifacts(fixture)
    } finally {
      release()
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rolls back the old root when the post-swap gate fails', async () => {
    const fixture = await makeFixture()
    const originalRun = fixture.run
    let gateCalls = 0
    fixture.run = async (executable, args, options) => {
      if (executable === process.execPath && args[1] === '--version') {
        gateCalls += 1
        if (gateCalls === 2) throw new Error('post-swap process failed')
      }
      return originalRun(executable, args, options)
    }
    try {
      await expect(runTransaction(fixture)).rejects.toThrow(
        'post-swap process failed',
      )
      expect(
        await readFile(
          join(fixture.layout.packageRoot, 'package.json'),
          'utf8',
        ),
      ).toBe(fixture.oldManifest)
      expect(
        await readFile(
          join(fixture.layout.packageRoot, 'dist', 'cli.js'),
          'utf8',
        ),
      ).toBe(fixture.oldCli)
      await assertNoArtifacts(fixture)
      const siblings = await readdir(dirname(fixture.layout.packageRoot))
      expect(
        siblings.filter((name) => name.startsWith(`${packageName}.failed-`)),
      ).toEqual([])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('preserves an abort reason before commit and cleans the transaction', async () => {
    const fixture = await makeFixture()
    const controller = new AbortController()
    const reason = new DOMException('unique cancellation reason', 'AbortError')
    const originalRun = fixture.run
    fixture.run = async (executable, args, options) => {
      const result = await originalRun(executable, args, options)
      if (executable === process.execPath && args[1] === '--version')
        controller.abort(reason)
      return result
    }
    try {
      await expect(
        runSelfUpdate({
          operation: 'install',
          target: targetVersion,
          npmExecutable: 'npm',
          layout: fixture.layout,
          run: fixture.run,
          signal: controller.signal,
        }),
      ).rejects.toThrow('unique cancellation reason')
      expect(
        await readFile(
          join(fixture.layout.packageRoot, 'package.json'),
          'utf8',
        ),
      ).toBe(fixture.oldManifest)
      await assertNoArtifacts(fixture)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('recovers an exact backup through the external launcher when the owner is dead', async () => {
    const fixture = await makeFixture()
    const { layout } = fixture
    const launcher = `${layout.packageRoot}.launcher.mjs`
    const backup = `${layout.packageRoot}.update-backup-${randomUUID()}`
    const staging = join(
      dirname(layout.packageRoot),
      `.praxis-update-${randomUUID()}`,
    )
    const journal = `${layout.packageRoot}.update.journal`
    try {
      await rm(layout.packageRoot, { recursive: true, force: true })
      await rm(layout.binPath, { force: true })
      await mkdir(backup, { recursive: true })
      await mkdir(staging, { recursive: true })
      await writeFile(join(backup, 'package.json'), fixture.oldManifest)
      await mkdir(join(backup, 'dist'), { recursive: true })
      await writeFile(join(backup, 'dist', 'cli.js'), fixture.oldCli)
      await writeFile(
        `${layout.packageRoot}.update.lock`,
        JSON.stringify({
          version: 1,
          pid: 999999,
          token: 'dead-owner',
          createdAt: new Date().toISOString(),
        }),
      )
      await writeFile(
        journal,
        JSON.stringify({
          version: 1,
          root: layout.packageRoot,
          backup,
          staging,
          targetVersion,
          phase: 'backup',
        }),
      )
      const launcherSource = generateLauncherSource(
        layout,
        `${layout.packageRoot}.update.lock`,
        journal,
      )
      expect(launcherSource.startsWith('#!/usr/bin/env node\n')).toBe(true)
      await writeFile(launcher, launcherSource, { mode: 0o700 })
      await symlink(launcher, layout.binPath)
      const child = await execFileAsync(layout.binPath, ['--version'])
      expect(child.stdout.trim()).toBe(oldVersion)
      expect(
        await readFile(join(layout.packageRoot, 'package.json'), 'utf8'),
      ).toBe(fixture.oldManifest)
      expect(await exists(backup)).toBe(false)
      expect(await exists(staging)).toBe(false)
      expect(await exists(journal)).toBe(false)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('does not recover or consume a backup while a live owner holds the lock', async () => {
    const fixture = await makeFixture()
    const { layout } = fixture
    const launcher = `${layout.packageRoot}.launcher.mjs`
    const backup = `${layout.packageRoot}.update-backup-${randomUUID()}`
    const staging = join(
      dirname(layout.packageRoot),
      `.praxis-update-${randomUUID()}`,
    )
    const journal = `${layout.packageRoot}.update.journal`
    try {
      await rm(layout.packageRoot, { recursive: true, force: true })
      await rm(layout.binPath, { force: true })
      await mkdir(backup, { recursive: true })
      await mkdir(staging, { recursive: true })
      await writeFile(join(backup, 'package.json'), fixture.oldManifest)
      await writeFile(
        `${layout.packageRoot}.update.lock`,
        JSON.stringify({
          version: 1,
          pid: process.pid,
          token: 'live-owner',
          createdAt: new Date().toISOString(),
        }),
      )
      await writeFile(
        journal,
        JSON.stringify({
          version: 1,
          root: layout.packageRoot,
          backup,
          staging,
          targetVersion,
          phase: 'backup',
        }),
      )
      await writeFile(
        launcher,
        generateLauncherSource(
          layout,
          `${layout.packageRoot}.update.lock`,
          journal,
        ),
        { mode: 0o700 },
      )
      await symlink(launcher, layout.binPath)
      await expect(
        execFileAsync(layout.binPath, ['--version']),
      ).rejects.toMatchObject({
        code: 1,
      })
      expect(await exists(backup)).toBe(true)
      expect(await exists(staging)).toBe(true)
      expect(await exists(journal)).toBe(true)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('recovers through the external launcher when a live-pid lock is malformed', async () => {
    const fixture = await makeFixture()
    const { layout } = fixture
    const launcher = `${layout.packageRoot}.launcher.mjs`
    const backup = `${layout.packageRoot}.update-backup-${randomUUID()}`
    const staging = join(
      dirname(layout.packageRoot),
      `.praxis-update-${randomUUID()}`,
    )
    const journal = `${layout.packageRoot}.update.journal`
    try {
      await rm(layout.packageRoot, { recursive: true, force: true })
      await rm(layout.binPath, { force: true })
      await mkdir(backup, { recursive: true })
      await mkdir(staging, { recursive: true })
      await writeFile(join(backup, 'package.json'), fixture.oldManifest)
      await mkdir(join(backup, 'dist'), { recursive: true })
      await writeFile(join(backup, 'dist', 'cli.js'), fixture.oldCli)
      await writeFile(
        `${layout.packageRoot}.update.lock`,
        JSON.stringify({
          version: 1,
          pid: process.pid,
          token: 'malformed token',
          createdAt: new Date().toISOString(),
        }),
      )
      await writeFile(
        journal,
        JSON.stringify({
          version: 1,
          root: layout.packageRoot,
          backup,
          staging,
          targetVersion,
          phase: 'backup',
        }),
      )
      await writeFile(
        launcher,
        generateLauncherSource(
          layout,
          `${layout.packageRoot}.update.lock`,
          journal,
        ),
        { mode: 0o700 },
      )
      await symlink(launcher, layout.binPath)
      const child = await execFileAsync(layout.binPath, ['--version'])
      expect(child.stdout.trim()).toBe(oldVersion)
      expect(
        await readFile(join(layout.packageRoot, 'package.json'), 'utf8'),
      ).toBe(fixture.oldManifest)
      expect(await exists(backup)).toBe(false)
      expect(await exists(staging)).toBe(false)
      expect(await exists(journal)).toBe(false)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a malicious journal path without touching an outside marker', async () => {
    const fixture = await makeFixture()
    const { layout } = fixture
    const launcher = `${layout.packageRoot}.launcher.mjs`
    const outside = join(fixture.root, 'outside-marker')
    const maliciousStaging = join(fixture.root, 'outside-staging')
    const journal = `${layout.packageRoot}.update.journal`
    try {
      await mkdir(maliciousStaging, { recursive: true })
      await writeFile(outside, 'keep me')
      await writeFile(join(maliciousStaging, 'marker'), 'keep me')
      await writeFile(
        journal,
        JSON.stringify({
          version: 1,
          root: layout.packageRoot,
          backup: `${layout.packageRoot}.update-backup-${randomUUID()}`,
          staging: maliciousStaging,
          targetVersion,
          phase: 'candidate',
        }),
      )
      await writeFile(
        launcher,
        generateLauncherSource(
          layout,
          `${layout.packageRoot}.update.lock`,
          journal,
        ),
        { mode: 0o700 },
      )
      await rm(layout.binPath, { force: true })
      await symlink(launcher, layout.binPath)
      await expect(
        execFileAsync(layout.binPath, ['--version']),
      ).rejects.toMatchObject({
        code: 1,
      })
      expect(await readFile(outside, 'utf8')).toBe('keep me')
      expect(await exists(maliciousStaging)).toBe(true)
      expect(await readFile(join(maliciousStaging, 'marker'), 'utf8')).toBe(
        'keep me',
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})
