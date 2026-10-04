// SPDX-License-Identifier: MIT
// Copyright (c) 2026 anmul
//
// Minimal PNG writer: 8-bit RGBA, no external dependencies.
//
// Why hand-rolled instead of a library: the pet build must run on a bare node
// with nothing installed. `zlib` is in the standard library; a PNG encoder is
// about 40 lines on top of it. Pulling in `sharp` or `pngjs` for two chunk
// types would make the asset build depend on a native module for no gain.
//
// Reference: PNG spec (RFC 2083), section 5 (data structures).

import { deflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** CRC-32 table, built once. PNG chunks are CRC-32 over chunkType+data. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** @param {Buffer} buf @returns {number} */
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** @param {string} type @param {Buffer} data @returns {Buffer} */
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/**
 * Encode straight (non-premultiplied) RGBA bytes as a PNG.
 *
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba - width*height*4 bytes, row-major.
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePng: expected ${width * height * 4} bytes, got ${rgba.length}`)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: truecolour with alpha
  ihdr[10] = 0 // compression: deflate
  ihdr[11] = 0 // filter: adaptive
  ihdr[12] = 0 // interlace: none

  // One filter byte per scanline. Filter 0 (None) is used everywhere: the pet
  // frames are flat brand colours on transparency, where the per-scanline
  // predictors buy nothing and cost a fifth pass over the data.
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
