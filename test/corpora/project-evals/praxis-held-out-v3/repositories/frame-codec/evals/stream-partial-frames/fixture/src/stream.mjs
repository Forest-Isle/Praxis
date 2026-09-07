/* global Buffer */

import { decodeFrame } from './frame.mjs'

export class FrameDecoder {
  push(chunk) {
    const input = Buffer.from(chunk)
    if (input.length < 4) return []
    const length = input.readUInt32BE(0)
    if (input.length < length + 4) return []
    return [decodeFrame(input.subarray(0, length + 4))]
  }
}
