import { describe, expect, it } from 'vitest'

import {
  resolveDataPlane,
  resolveDataPlanePaths,
  resolveDataPlaneRoot,
  resolveScheduledTaskFile,
} from './data-plane.js'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'

describe('data plane paths', () => {
  it('uses an isolated Praxis home by default', () => {
    const environment = {} as Record<string, string | undefined>
    const paths = resolveDataPlanePaths({
      cwd: '/work/example',
      sessionId: SESSION_ID,
      environment,
      homeDirectory: '/home/alice',
    })

    expect(paths).toMatchObject({
      dataPlane: 'native',
      root: '/home/alice/.praxis',
      projectRoot: '/home/alice/.praxis/sessions/-work-example',
      sessionFile:
        '/home/alice/.praxis/sessions/-work-example/11111111-1111-4111-8111-111111111111.jsonl',
      memoryRoot: '/home/alice/.praxis/memory/-work-example',
      stateRoot: '/home/alice/.praxis/state',
    })
    expect(
      resolveScheduledTaskFile({
        dataPlane: paths.dataPlane,
        cwd: '/work/example',
        root: paths.root,
      }),
    ).toBe('/home/alice/.praxis/scheduled/-work-example.json')
  })

  it('uses Claude paths only when explicitly selected', () => {
    const environment = {
      PRAXIS_DATA_PLANE: 'claude',
      CLAUDE_CONFIG_DIR: '/shared/claude',
    }
    const paths = resolveDataPlanePaths({
      cwd: '/work/example',
      sessionId: SESSION_ID,
      environment,
    })

    expect(paths.root).toBe('/shared/claude')
    expect(paths.sessionFile).toBe(
      '/shared/claude/projects/-work-example/11111111-1111-4111-8111-111111111111.jsonl',
    )
    expect(
      resolveScheduledTaskFile({
        dataPlane: 'claude',
        cwd: '/work/example',
        root: paths.root,
      }),
    ).toBe('/work/example/.claude/scheduled_tasks.json')
  })

  it('honours PRAXIS_HOME without reading CLAUDE_CONFIG_DIR in native mode', () => {
    const environment = {
      PRAXIS_HOME: '/private/praxis',
      CLAUDE_CONFIG_DIR: '/shared/claude',
    }
    expect(resolveDataPlane(environment)).toBe('native')
    expect(resolveDataPlaneRoot({ environment })).toBe('/private/praxis')
  })

  it('treats empty data-plane root environment variables as unset', () => {
    for (const value of ['', '   ', '\t\n']) {
      expect(
        resolveDataPlaneRoot({
          dataPlane: 'native',
          environment: { PRAXIS_HOME: value },
          homeDirectory: '/home/alice',
        }),
      ).toBe('/home/alice/.praxis')
      expect(
        resolveDataPlaneRoot({
          dataPlane: 'claude',
          environment: { CLAUDE_CONFIG_DIR: value },
          homeDirectory: '/home/alice',
        }),
      ).toBe('/home/alice/.claude')
    }
  })

  it('rejects an invalid plane', () => {
    expect(() => resolveDataPlane({ PRAXIS_DATA_PLANE: 'both' })).toThrow(
      'PRAXIS_DATA_PLANE',
    )
  })
})
