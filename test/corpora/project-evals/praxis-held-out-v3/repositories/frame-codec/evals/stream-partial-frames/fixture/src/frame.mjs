/* global Buffer */

export function decodeFrame(frame) {
  if (frame.length < 4) throw new Error('Invalid frame length')
  const length = frame.readUInt32BE(0)
  if (frame.length !== 4 + length) throw new Error('Invalid frame length')
  return Buffer.from(frame.subarray(4))
}
