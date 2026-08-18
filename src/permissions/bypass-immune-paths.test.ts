import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { bypassImmuneWriteReason } from './bypass-immune-paths.js'

const HOME = '/home/test-user'
const CONFIG_ROOT = join(HOME, '.claude')

describe('bypassImmuneWriteReason', () => {
  it('blocks everything under the home .ssh directory', () => {
    for (const path of [
      join(HOME, '.ssh', 'id_rsa'),
      join(HOME, '.ssh', 'authorized_keys'),
      join(HOME, '.ssh', 'config'),
      join(HOME, '.ssh', 'sub', 'id_ed25519'),
    ]) {
      expect(
        bypassImmuneWriteReason(path, {
          homeDirectory: HOME,
          configRoot: CONFIG_ROOT,
        }),
      ).toBeDefined()
    }
  })

  it('blocks everything under the home .aws directory', () => {
    for (const path of [
      join(HOME, '.aws', 'credentials'),
      join(HOME, '.aws', 'config'),
      join(HOME, '.aws', 'sub', 'shared-creds'),
    ]) {
      expect(
        bypassImmuneWriteReason(path, {
          homeDirectory: HOME,
          configRoot: CONFIG_ROOT,
        }),
      ).toBeDefined()
    }
  })

  it('blocks protected secret basenames anywhere', () => {
    for (const name of [
      'authorized_keys',
      'id_rsa',
      'id_ed25519',
      'id_ecdsa',
      'id_dsa',
      'credentials',
    ]) {
      expect(
        bypassImmuneWriteReason(join('/some/project', name), {
          homeDirectory: HOME,
          configRoot: CONFIG_ROOT,
        }),
      ).toBeDefined()
    }
  })

  it('blocks .env and .env.* files anywhere', () => {
    for (const name of ['.env', '.env.local', '.env.production']) {
      expect(
        bypassImmuneWriteReason(join('/some/project', name), {
          homeDirectory: HOME,
          configRoot: CONFIG_ROOT,
        }),
      ).toBeDefined()
    }
  })

  it('blocks settings.json and *.jsonl under the config root', () => {
    for (const path of [
      join(CONFIG_ROOT, 'settings.json'),
      join(CONFIG_ROOT, 'todos.jsonl'),
      join(CONFIG_ROOT, 'projects', 'p', 'history.jsonl'),
    ]) {
      expect(
        bypassImmuneWriteReason(path, {
          homeDirectory: HOME,
          configRoot: CONFIG_ROOT,
        }),
      ).toBeDefined()
    }
  })

  it('allows ordinary project files outside the protected roots', () => {
    for (const path of [
      join('/some/project', 'app.ts'),
      join('/some/project', 'settings.json'),
      join('/some/project', 'notes.jsonl'),
      join(HOME, '.ssh-notes', 'id_rsa.txt'),
      join(CONFIG_ROOT, 'README.md'),
      join(HOME, 'notes', 'credentials.txt'),
    ]) {
      expect(
        bypassImmuneWriteReason(path, {
          homeDirectory: HOME,
          configRoot: CONFIG_ROOT,
        }),
      ).toBeUndefined()
    }
  })
})
