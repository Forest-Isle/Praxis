export function classifyTranscriptAppend(
  written: Uint8Array,
  previousByteLength: number,
  encodedLine: Uint8Array,
): 'appended' | 'interleaved-write' {
  const expectedEnd = previousByteLength + encodedLine.length
  if (
    written.length === expectedEnd &&
    Buffer.from(written)
      .subarray(previousByteLength, expectedEnd)
      .equals(encodedLine)
  )
    return 'appended'
  return 'interleaved-write'
}
