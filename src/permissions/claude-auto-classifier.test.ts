import { describe, expect, it } from 'vitest'

import type { ModelProvider, ModelRequest } from '../core/runtime.js'
import {
  createClaudeModelAutoClassifier,
  loadClaudeAutoModeConfig,
} from './claude-auto-classifier.js'

describe('Claude auto-mode classifier', () => {
  it('loads default and configured rule lists', () => {
    const config = loadClaudeAutoModeConfig([
      {
        path: '/config/settings.json',
        scope: 'user',
        value: {
          autoMode: {
            allow: ['$defaults', 'custom allow'],
            soft_deny: ['custom soft deny'],
            hard_deny: ['custom hard deny'],
            environment: ['custom environment'],
            classifyAllShell: true,
          },
        },
      },
    ])
    expect(config.allow).toEqual([
      'Read-only project inspection and local development operations',
      'Routine retries after transient tool failures',
      'custom allow',
    ])
    expect(config.softDeny).toEqual(['custom soft deny'])
    expect(config.hardDeny).toEqual(['custom hard deny'])
    expect(config.environment).toEqual(['custom environment'])
    expect(config.classifyAllShell).toBe(true)
  })

  it('sends action and recent context to provider and parses JSON decision', async () => {
    let request: ModelRequest | undefined
    const provider: ModelProvider = {
      model: 'classifier-fixture',
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete(current) {
        request = current
        yield {
          type: 'text-delta',
          delta: '```json\n{"behavior":"ask","reason":"review"}\n```',
        }
      },
    }
    const classify = createClaudeModelAutoClassifier(provider)
    await expect(
      classify({
        call: {
          id: 'write',
          name: 'Write',
          input: { file_path: '/workspace/output.txt', content: 'x' },
        },
        cwd: '/workspace',
        messages: [{ role: 'user', content: 'edit the file' }],
        config: {
          allow: ['routine'],
          softDeny: ['external writes'],
          hardDeny: ['credential exfiltration'],
          environment: ['local project'],
          classifyAllShell: false,
        },
      }),
    ).resolves.toEqual({ behavior: 'ask', reason: 'review' })
    expect(request?.messages[0]?.content).toContain('credential exfiltration')
    expect(request?.messages[1]?.content).toContain('output.txt')
    expect(request?.messages[1]?.content).toContain('edit the file')
  })

  it('rejects malformed classifier output', async () => {
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        yield { type: 'text-delta', delta: 'not a decision' }
      },
    }
    await expect(
      createClaudeModelAutoClassifier(provider)({
        call: { id: 'write', name: 'Write', input: {} },
        cwd: '/workspace',
        messages: [],
        config: {
          allow: [],
          softDeny: [],
          hardDeny: [],
          environment: [],
          classifyAllShell: false,
        },
      }),
    ).rejects.toThrow('no JSON decision')
  })
})
