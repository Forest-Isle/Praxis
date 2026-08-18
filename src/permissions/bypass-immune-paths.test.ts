import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { protectedWritePathReason } from './bypass-immune-paths.js'

const roots: string[] = []

function tempHome(): { home: string; configRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'praxis-protected-'))
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return { home, configRoot: join(home, '.claude') }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('protectedWritePathReason', () => {
  it('rejects writes inside a temporary HOME/.ssh and HOME/.aws', () => {
    const { home, configRoot } = tempHome()
    const ssh = join(home, '.ssh')
    const aws = join(home, '.aws')
    mkdirSync(ssh, { recursive: true })
    mkdirSync(aws, { recursive: true })
    writeFileSync(join(ssh, 'authorized_keys'), '')
    expect(
      protectedWritePathReason(join(ssh, 'authorized_keys'), {
        homeDirectory: home,
        configRoot,
      }),
    ).toMatch(/protected/)
    expect(
      protectedWritePathReason(join(ssh, 'config'), {
        homeDirectory: home,
        configRoot,
      }),
    ).toMatch(/protected/)
    expect(
      protectedWritePathReason(join(aws, 'credentials'), {
        homeDirectory: home,
        configRoot,
      }),
    ).toMatch(/protected/)
  })

  it('rejects protected credential basenames outside the home directories', () => {
    const { home, configRoot } = tempHome()
    const project = join(home, 'project')
    mkdirSync(project, { recursive: true })
    for (const basename of [
      'authorized_keys',
      'id_rsa',
      'id_ed25519',
      'id_ecdsa',
      'id_dsa',
      'credentials',
      '.env',
      '.env.local',
    ]) {
      expect(
        protectedWritePathReason(join(project, basename), {
          homeDirectory: home,
          configRoot,
        }),
      ).toMatch(/protected/)
    }
  })

  it('rejects settings.json and jsonl files inside configRoot', () => {
    const { home, configRoot } = tempHome()
    mkdirSync(join(configRoot, 'projects'), { recursive: true })
    expect(
      protectedWritePathReason(join(configRoot, 'settings.json'), {
        homeDirectory: home,
        configRoot,
      }),
    ).toMatch(/protected/)
    expect(
      protectedWritePathReason(join(configRoot, 'projects', 'logs.jsonl'), {
        homeDirectory: home,
        configRoot,
      }),
    ).toMatch(/protected/)
  })

  it('allows ordinary workspace writes and out-of-configRoot settings names', () => {
    const { home, configRoot } = tempHome()
    const project = join(home, 'project')
    mkdirSync(project, { recursive: true })
    expect(
      protectedWritePathReason(join(project, 'notes.txt'), {
        homeDirectory: home,
        configRoot,
      }),
    ).toBeUndefined()
    expect(
      protectedWritePathReason(join(project, 'settings.json'), {
        homeDirectory: home,
        configRoot,
      }),
    ).toBeUndefined()
    expect(
      protectedWritePathReason(join(project, '.environment'), {
        homeDirectory: home,
        configRoot,
      }),
    ).toBeUndefined()
  })
})
