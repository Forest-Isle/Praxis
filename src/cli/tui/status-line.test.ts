import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import {
  createClaudeStatusLineInput,
  executeClaudeStatusLine,
  loadClaudeStatusLineSetting,
} from './status-line.js'

describe('Claude status line', () => {
  it('merges shared settings sources and honors disableAllHooks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-statusline-'))
    const cwd = join(root, 'workspace')
    const configRoot = join(root, 'config')
    await mkdir(join(cwd, '.claude'), { recursive: true })
    await mkdir(configRoot)
    await writeFile(
      join(configRoot, 'settings.json'),
      JSON.stringify({
        statusLine: { type: 'command', command: 'printf user', padding: 2 },
      }),
    )
    await writeFile(
      join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ disableAllHooks: true }),
    )

    await expect(
      loadClaudeStatusLineSetting({ configRoot, cwd }),
    ).resolves.toEqual({
      setting: { type: 'command', command: 'printf user', padding: 2 },
      disabled: true,
    })
    await expect(
      loadClaudeStatusLineSetting({
        configRoot,
        cwd,
        settingSources: ['user'],
      }),
    ).resolves.toEqual({
      setting: { type: 'command', command: 'printf user', padding: 2 },
      disabled: false,
    })
  })

  it('passes a supplied terminal width as COLUMNS to the command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-statusline-'))
    const input = createClaudeStatusLineInput({
      configRoot: root,
      cwd: root,
      projectDir: root,
      sessionId: '11111111-1111-4111-8111-111111111111',
      version: '2.1.208',
      outputStyle: 'default',
      additionalDirectories: [],
    })
    const output = await executeClaudeStatusLine(
      {
        type: 'command',
        command:
          "node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(process.env.COLUMNS))\"",
      },
      input,
      { cwd: root, columns: 40 },
    )
    expect(output).toBe('40')
  })

  it('writes structured JSON to stdin and normalizes successful output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-statusline-'))
    const input = createClaudeStatusLineInput({
      configRoot: root,
      cwd: root,
      projectDir: root,
      sessionId: '11111111-1111-4111-8111-111111111111',
      sessionName: 'work',
      model: 'claude-test',
      version: '2.1.208',
      outputStyle: 'default',
      permissionMode: 'plan',
      additionalDirectories: ['/tmp/extra'],
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        cacheCreationInputTokens: 7,
        cacheReadInputTokens: 3,
      },
      contextWindowTokens: 100,
      vimMode: 'NORMAL',
    })
    const output = await executeClaudeStatusLine(
      {
        type: 'command',
        command:
          "node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s);console.log('  '+x.model.id+'  ');console.log('');console.log(' '+x.vim.mode)})\"",
      },
      input,
      { cwd: root },
    )
    expect(output).toBe('claude-test\nNORMAL')
    expect(input.context_window.used_percentage).toBe(30)
    expect(input.context_window.remaining_percentage).toBe(70)
    expect(input.session_name).toBe('work')
  })

  it('silently drops non-zero and timed-out commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-statusline-'))
    const orphanPath = join(root, 'orphan.txt')
    const input = createClaudeStatusLineInput({
      configRoot: root,
      cwd: root,
      projectDir: root,
      sessionId: '11111111-1111-4111-8111-111111111111',
      version: '2.1.208',
      outputStyle: 'default',
      additionalDirectories: [],
    })
    await expect(
      executeClaudeStatusLine({ type: 'command', command: 'exit 7' }, input, {
        cwd: root,
      }),
    ).resolves.toBeUndefined()
    await expect(
      executeClaudeStatusLine(
        {
          type: 'command',
          command: `node -e "setTimeout(()=>require('fs').writeFileSync('${orphanPath}','orphan'),200)"`,
        },
        input,
        { cwd: root, timeoutMs: 20 },
      ),
    ).resolves.toBeUndefined()
    await delay(300)
    await expect(readFile(orphanPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
