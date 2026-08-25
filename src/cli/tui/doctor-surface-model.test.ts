import { describe, expect, it } from 'vitest'

import type { DoctorReport } from '../../maintenance/doctor.js'
import { projectTuiDoctorSurface } from './doctor-surface-model.js'

describe('projectTuiDoctorSurface', () => {
  it('preserves doctor payload identity and values', () => {
    const report = {} as DoctorReport
    const surface = projectTuiDoctorSurface({
      loading: false,
      report,
      error: null,
    })

    expect(surface).toEqual({
      kind: 'doctor-panel',
      loading: false,
      report,
      error: null,
    })
    expect(surface.report).toBe(report)
  })
})
