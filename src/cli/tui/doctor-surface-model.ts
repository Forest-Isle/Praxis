import type {
  DoctorProgressReport,
  DoctorReport,
} from '../../maintenance/doctor.js'

export interface TuiDoctorSurfaceModel {
  readonly kind: 'doctor-panel'
  readonly loading: boolean
  readonly report: DoctorReport | DoctorProgressReport | null
  readonly error: string | null
}

export function projectTuiDoctorSurface(input: {
  loading: boolean
  report: DoctorReport | DoctorProgressReport | null
  error: string | null
}): TuiDoctorSurfaceModel {
  return {
    kind: 'doctor-panel',
    loading: input.loading,
    report: input.report,
    error: input.error,
  }
}
