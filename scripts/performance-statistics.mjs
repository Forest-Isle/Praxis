export function percentile(samples, percentileValue) {
  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.max(
    0,
    Math.min(
      sorted.length - 1,
      Math.ceil((percentileValue / 100) * sorted.length) - 1,
    ),
  )
  return sorted[index]
}

export function minimumPercentileSampleCount(percentileValue) {
  if (percentileValue <= 0 || percentileValue >= 100) {
    throw new RangeError('Percentile must be greater than 0 and less than 100')
  }
  return Math.ceil(100 / (100 - percentileValue))
}
