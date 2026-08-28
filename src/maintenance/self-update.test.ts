import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  checksum,
  type SelfUpdateLayout,
  type TransactionRunner,
} from './self-update-transaction.js'
import { runSelfUpdate } from './self-update.js'

const packageName = 'praxis-agent'

interface Fixture {
  root: string
  layout: SelfUpdateLayout
  run: TransactionRunner
}

async function makeFixture(target: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-self-update-api-'))
  const prefix = join(root, 'prefix')
  const modules = join(prefix, 'lib', 'node_modules')
  const packageRoot = join(modules, packageName)
  await mkdir(join(packageRoot, 'dist'), { recursive: true })
  await mkdir(join(prefix, 'bin'), { recursive: true })
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: packageName, version: '1.0.0' }),
  )
  await writeFile(join(packageRoot, 'dist', 'cli.js'), 'old cli')
  const bytes = Buffer.from(`fixture-${target}`)
  const sums = checksum(bytes)
  const run: TransactionRunner = async (executable, args) => {
    if (executable === 'npm' && args[0] === 'view') {
      return {
        stdout: JSON.stringify({
          version: target,
          dist: {
            tarball: 'https://registry.example/praxis-agent.tgz',
            integrity: sums.sha512,
            shasum: sums.sha1,
          },
        }),
        stderr: '',
      }
    }
    if (executable === 'npm' && args[0] === 'pack') {
      const destination = args[args.indexOf('--pack-destination') + 1]
      if (!destination) throw new Error('missing pack destination')
      const filename = `${packageName}-${target}.tgz`
      await mkdir(destination, { recursive: true })
      await writeFile(join(destination, filename), bytes)
      return {
        stdout: JSON.stringify([
          {
            name: packageName,
            version: target,
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
      const stagingPrefix = args[prefixIndex + 1]
      if (!stagingPrefix) throw new Error('missing staging prefix')
      const candidate = join(stagingPrefix, 'lib', 'node_modules', packageName)
      await mkdir(join(candidate, 'dist'), { recursive: true })
      await writeFile(
        join(candidate, 'package.json'),
        JSON.stringify({ name: packageName, version: target }),
      )
      await writeFile(join(candidate, 'dist', 'cli.js'), 'candidate cli')
      return { stdout: '', stderr: '' }
    }
    if (executable === process.execPath && args[1] === '--version')
      return { stdout: `${target}\n`, stderr: '' }
    throw new Error(`unexpected runner call ${executable} ${args.join(' ')}`)
  }
  return {
    root,
    layout: {
      packageRoot,
      globalNodeModulesRoot: modules,
      globalPrefix: prefix,
      binPath: join(prefix, 'bin', 'praxis'),
    },
    run,
  }
}

describe('Praxis self update public contract', () => {
  it('uses stable for install and returns the legacy logical command/result', async () => {
    const fixture = await makeFixture('2.0.0')
    try {
      await expect(
        runSelfUpdate({
          operation: 'install',
          npmExecutable: 'npm',
          layout: fixture.layout,
          run: fixture.run,
        }),
      ).resolves.toEqual({
        type: 'self-update',
        operation: 'install',
        package: packageName,
        target: 'stable',
        force: false,
        command: [
          'npm',
          'install',
          '--global',
          '--no-fund',
          '--no-audit',
          '--ignore-scripts',
          `${packageName}@stable`,
        ],
        output: 'completed',
      })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('defaults update to latest and supports exact versions and force', async () => {
    const fixture = await makeFixture('2.0.0')
    try {
      await expect(
        runSelfUpdate({
          operation: 'update',
          npmExecutable: 'npm',
          layout: fixture.layout,
          run: fixture.run,
        }),
      ).resolves.toMatchObject({
        operation: 'update',
        target: 'latest',
        force: false,
        command: [
          'npm',
          'install',
          '--global',
          '--no-fund',
          '--no-audit',
          '--ignore-scripts',
          `${packageName}@latest`,
        ],
      })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }

    const exact = await makeFixture('1.2.3-beta.1')
    try {
      await expect(
        runSelfUpdate({
          operation: 'install',
          target: '1.2.3-beta.1',
          force: true,
          npmExecutable: 'npm',
          layout: exact.layout,
          run: exact.run,
        }),
      ).resolves.toMatchObject({
        operation: 'install',
        target: '1.2.3-beta.1',
        force: true,
        command: [
          'npm',
          'install',
          '--global',
          '--no-fund',
          '--no-audit',
          '--ignore-scripts',
          '--force',
          `${packageName}@1.2.3-beta.1`,
        ],
      })
    } finally {
      await rm(exact.root, { recursive: true, force: true })
    }
  })

  it('accepts stable/latest channels and rejects invalid packages or targets', async () => {
    for (const target of ['stable', 'latest', 'next', 'beta', 'canary']) {
      const fixture = await makeFixture('2.0.0')
      try {
        await expect(
          runSelfUpdate({
            operation: 'install',
            target,
            npmExecutable: 'npm',
            layout: fixture.layout,
            run: fixture.run,
          }),
        ).resolves.toMatchObject({ target })
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    }
    await expect(
      runSelfUpdate({ operation: 'install', packageName: 'bad/name' }),
    ).rejects.toThrow('Invalid Praxis package name')
    await expect(
      runSelfUpdate({ operation: 'install', target: 'latest;echo bad' }),
    ).rejects.toThrow('install target must be')
  })

  it('wraps transaction failures with the operation name', async () => {
    const fixture = await makeFixture('2.0.0')
    try {
      await expect(
        runSelfUpdate({
          operation: 'update',
          npmExecutable: 'npm',
          layout: fixture.layout,
          run: async () => {
            throw new Error('network unavailable')
          },
        }),
      ).rejects.toThrow('Praxis update failed: network unavailable')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('redacts subprocess stderr and temporary paths from public failures', async () => {
    if (process.platform === 'win32') return
    const fixture = await makeFixture('2.0.0')
    const secret = `self-update-secret-${Math.random().toString(36).slice(2)}`
    const executable = join(fixture.root, 'npm-redaction-fixture.sh')
    try {
      await writeFile(
        executable,
        `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(`${secret} ${fixture.root}`)} >&2\nexit 17\n`,
      )
      await chmod(executable, 0o700)
      let failure: unknown
      try {
        await runSelfUpdate({
          operation: 'install',
          target: '2.0.0',
          npmExecutable: executable,
          layout: fixture.layout,
        })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      const message = (failure as Error).message
      expect(message).toContain(
        'Praxis install failed: self-update subprocess failed',
      )
      expect(message).not.toContain(secret)
      expect(message).not.toContain(fixture.root)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('redacts filesystem paths from injected transaction failures', async () => {
    const fixture = await makeFixture('2.0.0')
    const secretPath = join(fixture.root, 'private', 'missing-package.json')
    try {
      const failure = Object.assign(new Error('open failed'), {
        code: 'ENOENT',
        syscall: 'open',
        path: secretPath,
      })
      let thrown: unknown
      try {
        await runSelfUpdate({
          operation: 'update',
          target: '2.0.0',
          npmExecutable: 'npm',
          layout: fixture.layout,
          run: async () => {
            throw failure
          },
        })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Error)
      const message = (thrown as Error).message
      expect(message).toContain(
        'Praxis update failed: self-update filesystem transaction failed',
      )
      expect(message).not.toContain(secretPath)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})
