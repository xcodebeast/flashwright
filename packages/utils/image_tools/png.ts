/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import zlib from 'zlib';

import type { ImageData } from '@isomorphic/imageUtils';

// Flashwright: decodes the PNGs browsers produce (8-bit RGB or RGBA, not interlaced, no
// palette or transparency key) about twice as fast as pngjs, with the same RGBA result.
// Returns undefined for anything else, including damaged files, so callers fall back to pngjs
// and keep its behavior and error messages.
export function decodeSimplePng(buffer: Buffer): ImageData | undefined {
  try {
    return decode(buffer);
  } catch {
    return undefined;
  }
}

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decode(buffer: Buffer): ImageData | undefined {
  // pngjs verifies chunk checksums; without a native crc32 the fast path is skipped.
  const crc32 = (zlib as any).crc32 as ((data: Buffer) => number) | undefined;
  if (!crc32 || buffer.length < 8 || !buffer.subarray(0, 8).equals(signature))
    return;
  let width = 0;
  let height = 0;
  let channels = 0;
  const compressed: Buffer[] = [];
  let pos = 8;
  let ended = false;
  while (pos + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const end = pos + 12 + length;
    if (end > buffer.length)
      return;
    const type = buffer.toString('latin1', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (crc32(buffer.subarray(pos + 4, pos + 8 + length)) !== buffer.readUInt32BE(pos + 8 + length))
      return;
    if (type === 'IHDR') {
      const [bitDepth, colorType, compression, filter, interlace] = data.subarray(8, 13);
      if (length !== 13 || bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || compression || filter || interlace)
        return;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      compressed.push(data);
    } else if (type === 'IEND') {
      ended = true;
      break;
    } else if (type === 'PLTE' || type === 'tRNS') {
      return;
    }
    pos = end;
  }
  if (!ended || !width || !height || !compressed.length)
    return;

  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(compressed));
  if (raw.length < height * (stride + 1))
    return;
  const out = Buffer.allocUnsafe(width * height * 4);
  let previous = new Uint8Array(stride);
  let current = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const row = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    switch (raw[rowStart]) {
      case 0:
        current.set(row);
        break;
      case 1:
        for (let i = 0; i < stride; i++)
          current[i] = row[i] + (i >= channels ? current[i - channels] : 0);
        break;
      case 2:
        for (let i = 0; i < stride; i++)
          current[i] = row[i] + previous[i];
        break;
      case 3:
        for (let i = 0; i < stride; i++)
          current[i] = row[i] + (((i >= channels ? current[i - channels] : 0) + previous[i]) >> 1);
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const left = i >= channels ? current[i - channels] : 0;
          const up = previous[i];
          const upLeft = i >= channels ? previous[i - channels] : 0;
          const estimate = left + up - upLeft;
          const toLeft = Math.abs(estimate - left);
          const toUp = Math.abs(estimate - up);
          const toUpLeft = Math.abs(estimate - upLeft);
          current[i] = row[i] + (toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft);
        }
        break;
      default:
        return;
    }
    if (channels === 4) {
      out.set(current, y * width * 4);
    } else {
      for (let x = 0, i = 0, o = y * width * 4; x < width; x++, i += 3, o += 4) {
        out[o] = current[i];
        out[o + 1] = current[i + 1];
        out[o + 2] = current[i + 2];
        out[o + 3] = 255;
      }
    }
    [previous, current] = [current, previous];
  }
  return { width, height, data: out };
}
