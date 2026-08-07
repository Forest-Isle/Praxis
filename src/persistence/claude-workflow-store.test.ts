import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ClaudeWorkflowPaths } from '../compatibility/claude/workflow.js'
import { workflowReplayDescriptor } from '../compatibility/claude/workflow-replay.js'
import { ClaudeWorkflowStore } from './claude-workflow-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

async function store() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-store-'))
  roots.push(root)
  const paths: ClaudeWorkflowPaths = {
    sessionDirectory: root,
    workflowDirectory: join(root, 'workflows'),
    scriptsDirectory: join(root, 'workflows', 'scripts'),
    scriptFile: join(root, 'workflows', 'scripts', 'probe-wf_probe.js'),
    runFile: join(root, 'workflows', 'wf_probe.json'),
    transcriptDirectory: join(root, 'subagents', 'workflows', 'wf_probe'),
    journalFile: join(
      root,
      'subagents',
      'workflows',
      'wf_probe',
      'journal.jsonl',
    ),
  }
  return new ClaudeWorkflowStore(paths)
}

describe('ClaudeWorkflowStore', () => {
  it('atomically writes scripts/runs and indexes only completed journal pairs', async () => {
    const value = await store()
    await value.initialize('script')
    await value.writeRun({ status: 'completed' })
    await value.append({
      type: 'started',
      key: 'v2:a',
      agentId: 'a0000000000000001',
    })
    await value.append({
      type: 'result',
      key: 'v2:a',
      agentId: 'a0000000000000001',
      result: { ok: true },
    })
    await value.appendMetadata({
      agentId: 'a0000000000000001',
      prompt: 'prompt-a',
      options: { effort: 'low' },
    })
    await value.append({
      type: 'started',
      key: 'v2:b',
      agentId: 'a0000000000000002',
    })
    await writeFile(
      join(value.paths.transcriptDirectory, 'agent-a0000000000000001.jsonl'),
      `${JSON.stringify({ message: { role: 'user', content: 'prompt-a' } })}\n`,
    )
    expect(await readFile(value.paths.scriptFile, 'utf8')).toBe('script')
    expect(JSON.parse(await readFile(value.paths.runFile, 'utf8'))).toEqual({
      status: 'completed',
    })
    expect(await value.replayIndex()).toEqual(
      new Map([
        ['v2:a', { agentId: 'a0000000000000001', result: { ok: true } }],
      ]),
    )
    expect(await value.replayByPrompt()).toEqual(
      new Map([
        ['prompt-a', { agentId: 'a0000000000000001', result: { ok: true } }],
      ]),
    )
    expect(await value.replayByDescriptor()).toEqual(
      new Map([
        [
          workflowReplayDescriptor('prompt-a', { effort: 'low' }),
          { agentId: 'a0000000000000001', result: { ok: true } },
        ],
      ]),
    )
    await writeFile(
      join(value.paths.transcriptDirectory, '.praxis-replay-metadata.jsonl'),
      `${JSON.stringify({
        agentId: 'a0000000000000001',
        prompt: 'prompt-a',
        options: { model: 7 },
      })}\n`,
    )
    await expect(value.replayByDescriptor()).rejects.toThrow(
      'Invalid workflow replay metadata at line 1',
    )
  })

  it('replays deterministic unchanged runs by started order while preserving holes', async () => {
    const value = await store()
    await value.initialize('script')
    await value.writeRun({
      script: 'script',
      args: { probe: 23 },
      status: 'completed',
    })
    await value.append({
      type: 'started',
      key: 'v2:foreign-a',
      agentId: 'a0000000000000001',
    })
    await value.append({
      type: 'started',
      key: 'v2:foreign-b',
      agentId: 'a0000000000000002',
    })
    await value.append({
      type: 'result',
      key: 'v2:foreign-a',
      agentId: 'a0000000000000001',
      result: 'first',
    })
    await expect(
      value.replayByOrderedSequence('script', { probe: 23 }, true),
    ).resolves.toEqual([
      { agentId: 'a0000000000000001', result: 'first' },
      undefined,
    ])
    await expect(
      value.replayByOrderedSequence('changed', { probe: 23 }, true),
    ).resolves.toEqual([])
    await expect(
      value.replayByOrderedSequence('script', { probe: 23 }, true),
    ).resolves.toEqual([
      { agentId: 'a0000000000000001', result: 'first' },
      undefined,
    ])
    await expect(
      value.replayByOrderedSequence('script', { probe: 23 }, false),
    ).resolves.toEqual([])
  })
})
