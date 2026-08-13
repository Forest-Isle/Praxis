import { describe, expect, it } from 'vitest'

import {
  minimumPercentileSampleCount,
  percentile,
} from './performance-statistics.mjs'

describe('performance percentile sampling', () => {
  it('uses enough p95 samples to keep one tail outlier outside the percentile', () => {
    const sampleCount = minimumPercentileSampleCount(95)
    const samples = [...Array.from({ length: sampleCount - 1 }, () => 100), 500]

    expect(sampleCount).toBe(20)
    expect(percentile(samples, 95)).toBe(100)
  })

  it('still fails p95 when more than five percent of samples regress', () => {
    const samples = [...Array.from({ length: 18 }, () => 100), 500, 600]

    expect(percentile(samples, 95)).toBe(500)
  })
})
