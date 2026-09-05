import { describe, expect, it } from 'vitest'

import { NativeDataPlaneAdapter } from './native-data-plane-adapter.js'
import {
  resolveInteractiveRuntimeSettingsLocation,
  resolveUnknownCostSidecarPath,
} from '../cli-runtime.js'
import {
  getNativeDataOwnership,
  NATIVE_DATA_OWNERSHIP,
} from '../native/ownership.js'
import {
  resolveNativePaths,
  resolveNativeScheduledTaskFile,
} from '../native/paths.js'
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

  it('rejects the removed Claude data plane', () => {
    const environment = {
      PRAXIS_DATA_PLANE: 'claude',
      PRAXIS_HOME: '/shared/claude',
    }
    expect(() => resolveDataPlane(environment)).toThrow(
      'PRAXIS_DATA_PLANE must be "native"',
    )
  })

  it('honours PRAXIS_HOME without reading a legacy config sentinel in native mode', () => {
    const environment = {
      PRAXIS_HOME: '/private/praxis',
      LEGACY_CONFIG_SENTINEL: '/shared/legacy',
    }
    expect(resolveDataPlane(environment)).toBe('native')
    expect(resolveDataPlaneRoot({ environment })).toBe('/private/praxis')
  })

  it('treats empty data-plane root environment variables as unset', () => {
    for (const value of ['', '   ', '\t\n']) {
      expect(
        resolveDataPlaneRoot({
          environment: { PRAXIS_HOME: value },
          homeDirectory: '/home/alice',
        }),
      ).toBe('/home/alice/.praxis')
    }
  })

  it('rejects an invalid plane', () => {
    expect(() => resolveDataPlane({ PRAXIS_DATA_PLANE: 'both' })).toThrow(
      'PRAXIS_DATA_PLANE',
    )
  })

  it('rejects runtime-invalid planes at path boundaries', () => {
    expect(() =>
      resolveDataPlanePaths({
        cwd: '/work/example',
        sessionId: SESSION_ID,
        dataPlane: 'claude' as never,
      }),
    ).toThrow('native data plane')
    expect(() =>
      resolveScheduledTaskFile({
        dataPlane: 'claude' as never,
        cwd: '/work/example',
        root: '/tmp/praxis',
      }),
    ).toThrow('native data plane')
    expect(() =>
      resolveInteractiveRuntimeSettingsLocation('claude' as never, {}),
    ).toThrow('native data plane')
    expect(() =>
      resolveUnknownCostSidecarPath('claude' as never, '/tmp/praxis'),
    ).toThrow('native data plane')
  })

  it('keeps the adapter path meanings aligned for injected roots', () => {
    const native = new NativeDataPlaneAdapter()
    const nativePaths = native.resolvePaths({
      cwd: '/work/example',
      sessionId: SESSION_ID,
      root: '/tmp/praxis',
    })

    expect(nativePaths).toMatchObject({
      dataPlane: 'native',
      root: '/tmp/praxis',
      taskRoot: '/tmp/praxis/tasks/11111111-1111-4111-8111-111111111111',
    })
    expect(
      native.resolveScheduledTaskFile({
        cwd: '/work/example',
        root: nativePaths.root,
      }),
    ).toBe('/tmp/praxis/scheduled/-work-example.json')
  })

  it('keeps native ownership metadata aligned with native path helpers', () => {
    expect(getNativeDataOwnership('transcript').location).toBe(
      'sessions/<project-key>/<session-id>.jsonl',
    )
    expect(getNativeDataOwnership('scheduled-prompts').location).toBe(
      'scheduled/<project-key>.json',
    )
    expect(getNativeDataOwnership('auto-memory').location).toBe(
      'memory/<project-key>/',
    )
    expect(getNativeDataOwnership('compaction-accounting')).toMatchObject({
      plane: 'praxis-sidecar',
      praxisAccess: 'read-write',
      location: 'compaction-receipts/<session-id>/',
    })
    expect(NATIVE_DATA_OWNERSHIP).toBeDefined()
    expect(
      resolveNativePaths({
        cwd: '/work/example',
        sessionId: SESSION_ID,
        configDir: '/tmp/praxis',
      }),
    ).toEqual(
      resolveNativePaths({
        cwd: '/work/example',
        sessionId: SESSION_ID,
        configDir: '/tmp/praxis',
      }),
    )
    expect(resolveNativeScheduledTaskFile('/work/example', '/tmp/praxis')).toBe(
      '/tmp/praxis/scheduled/-work-example.json',
    )
  })
})
