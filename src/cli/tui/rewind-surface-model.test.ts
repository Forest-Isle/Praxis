import { describe, expect, it } from 'vitest'
import {
  projectTuiRewindSurface,
  rewindActions,
  rewindPointWindow,
} from './rewind-surface-model.js'
import type { RewindPoint } from '../../application/session-service.js'

const point = (
  n: number,
  files: readonly string[] = ['/tmp/file.ts'],
): RewindPoint => ({
  messageId: `m${n}`,
  prompt: `Prompt ${n}`,
  fileChanges: files,
  fileRestoreAvailable: true,
})

describe('rewind surface model', () => {
  it('projects points with the bounded window and preserves identity', () => {
    const points = Array.from({ length: 8 }, (_, i) => point(i))
    const model = projectTuiRewindSurface({
      kind: 'rewind',
      points,
      selectedIndex: 5,
    })
    expect(model).toMatchObject({
      kind: 'rewind-panel',
      view: 'points',
      selectedIndex: 5,
      window: { start: 2, end: 8 },
    })
    expect(model.points).toBe(points)
    if (model.view === 'points')
      expect(rewindPointWindow(points, 5)).toEqual(model.window)
  })
  it('projects confirm actions and preserves point identity', () => {
    const selected = point(1)
    const points = [selected]
    const model = projectTuiRewindSurface({
      kind: 'rewind-confirm',
      points,
      point: selected,
      selectedIndex: 2,
    })
    expect(model.view).toBe('confirm')
    expect(model.points).toBe(points)
    if (model.view === 'confirm') {
      expect(model.point).toBe(selected)
      expect(model.actions).toEqual(rewindActions(selected))
    }
  })
  it('projects context text exactly', () => {
    const selected = point(1)
    const points = [selected]
    const model = projectTuiRewindSurface({
      kind: 'rewind-context',
      points,
      point: selected,
      direction: 'from',
      context: 'keep API compatibility',
    })
    expect(model).toMatchObject({
      view: 'context',
      direction: 'from',
      context: 'keep API compatibility',
    })
    expect(model.points).toBe(points)
  })
})
