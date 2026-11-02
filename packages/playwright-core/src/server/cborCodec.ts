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

import { isAscii, isUtf8 } from 'buffer';

// Flashwright: Chromium's DevTools protocol in its native CBOR form (--remote-debugging-pipe=cbor),
// see third_party/inspector_protocol/crdtp/cbor.h. Over JSON, the browser converts every message
// to CBOR and back, which for the injected script's 180 KB costs about a millisecond per document.
// Messages decode to what JSON.parse() gives for the same message in JSON mode, and encode to what
// the browser makes of JSON.stringify(): strings outside ASCII as UTF-16, binary values as base64
// strings, numbers that are not finite as null.

// A map or an array is wrapped in an envelope: tag 24, then a byte string with a 32-bit length.
const kEnvelopeHeaderSize = 7;
const kMajorUnsigned = 0;
const kMajorNegative = 1;
const kMajorByteString = 2;
const kMajorString = 3;
const kTagBase64 = 22;
const kTagEnvelope = 24;

let scratch = Buffer.allocUnsafe(64 * 1024);
let position = 0;

function reserve(size: number) {
  if (position + size <= scratch.length)
    return;
  const grown = Buffer.allocUnsafe(Math.max(scratch.length * 2, position + size));
  scratch.copy(grown, 0, 0, position);
  scratch = grown;
}

function writeHeader(major: number, value: number) {
  reserve(5);
  if (value < 24) {
    scratch[position++] = major << 5 | value;
  } else if (value < 0x100) {
    scratch[position++] = major << 5 | 24;
    scratch[position++] = value;
  } else if (value < 0x10000) {
    scratch[position++] = major << 5 | 25;
    scratch.writeUInt16BE(value, position);
    position += 2;
  } else {
    scratch[position++] = major << 5 | 26;
    scratch.writeUInt32BE(value, position);
    position += 4;
  }
}

function writeString(value: string) {
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (byteLength === value.length) {
    writeHeader(kMajorString, byteLength);
    reserve(byteLength);
    position += scratch.write(value, position, byteLength, 'latin1');
  } else {
    // UTF-16 keeps unpaired surrogates, as JSON's escapes do.
    writeHeader(kMajorByteString, value.length * 2);
    reserve(value.length * 2);
    position += scratch.write(value, position, value.length * 2, 'utf16le');
  }
}

// What JSON.stringify() does with a property's value before writing it (SerializeJSONProperty):
// toJSON(key), then boxed primitives unwrapped. kSkip stands for what it leaves out.
const kSkip = Symbol('skip');

function jsonValue(value: any, key: string): any {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function' || typeof value === 'bigint') {
    const toJSON = value.toJSON;
    if (typeof toJSON === 'function')
      value = toJSON.call(value, key);
  }
  if (typeof value === 'object' && value !== null) {
    if (value instanceof Number)
      value = Number(value);
    else if (value instanceof String)
      value = String(value);
    else if (value instanceof Boolean)
      value = value.valueOf();
    else if (value instanceof BigInt)
      value = value.valueOf();
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol')
    return kSkip;
  if (typeof value === 'bigint')
    throw new TypeError('Do not know how to serialize a BigInt');
  return value;
}

function writeValue(value: any) {
  if (typeof value === 'string') {
    writeString(value);
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      reserve(1);
      scratch[position++] = 0xf6;
    } else if (Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff) {
      writeHeader(value >= 0 ? kMajorUnsigned : kMajorNegative, value >= 0 ? value : -1 - value);
    } else {
      reserve(9);
      scratch[position++] = 0xfb;
      scratch.writeDoubleBE(value, position);
      position += 8;
    }
  } else if (typeof value === 'boolean') {
    reserve(1);
    scratch[position++] = value ? 0xf5 : 0xf4;
  } else if (value === null) {
    reserve(1);
    scratch[position++] = 0xf6;
  } else {
    reserve(kEnvelopeHeaderSize + 1);
    scratch[position++] = 0xd8;
    scratch[position++] = kTagEnvelope;
    scratch[position++] = kMajorByteString << 5 | 26;
    const lengthAt = position;
    position += 4;
    const start = position;
    if (Array.isArray(value)) {
      scratch[position++] = 0x9f;
      // By index up to the length it had, as JSON.stringify() reads arrays.
      const length = value.length;
      for (let i = 0; i < length; i++) {
        const item = jsonValue(value[i], String(i));
        writeValue(item === kSkip ? null : item);
      }
    } else {
      scratch[position++] = 0xbf;
      for (const key of Object.keys(value)) {
        const item = jsonValue(value[key], key);
        if (item === kSkip)
          continue;
        writeString(key);
        writeValue(item);
      }
    }
    reserve(1);
    scratch[position++] = 0xff;
    scratch.writeUInt32BE(position - start, lengthAt);
  }
}

let encoding = false;

export function encodeCBORMessage(message: object): Buffer {
  // A toJSON() or a getter that encodes another message gets a buffer of its own.
  if (encoding) {
    const [savedScratch, savedPosition] = [scratch, position];
    scratch = Buffer.allocUnsafe(1024);
    try {
      encoding = false;
      return encodeCBORMessage(message);
    } finally {
      encoding = true;
      [scratch, position] = [savedScratch, savedPosition];
    }
  }
  encoding = true;
  try {
    position = 0;
    const value = jsonValue(message, '');
    writeValue(value === kSkip ? null : value);
    return Buffer.from(scratch.subarray(0, position));
  } finally {
    encoding = false;
  }
}

// The size of the message that starts the buffer, or undefined until its header has arrived.
export function cborMessageSize(buffer: Buffer): number | undefined {
  if (buffer.length < kEnvelopeHeaderSize)
    return;
  if (buffer[0] !== 0xd8 || buffer[1] !== kTagEnvelope || buffer[2] !== (kMajorByteString << 5 | 26))
    throw new Error('Unexpected CBOR message header');
  return kEnvelopeHeaderSize + buffer.readUInt32BE(3);
}

let input: Buffer;
let offset = 0;

// Over JSON, the renderer converts each message from CBOR, which fails for values in containers
// more than 300 deep (crdtp's kStackLimit, see ParseCBOR); a response then becomes an error.
const kStackLimit = 300;
class StackLimitExceeded {
  constructor(readonly position: number) {}
}

function readLength(info: number): number {
  if (info < 24)
    return info;
  if (info === 24)
    return input[offset++];
  if (info === 25) {
    const value = input.readUInt16BE(offset);
    offset += 2;
    return value;
  }
  if (info === 26) {
    const value = input.readUInt32BE(offset);
    offset += 4;
    return value;
  }
  if (info === 27) {
    const value = Number(input.readBigUInt64BE(offset));
    offset += 8;
    return value;
  }
  throw new Error('Unsupported CBOR length');
}

function readString(length: number): string {
  const end = offset + length;
  let result: string | undefined;
  if (length < 32) {
    result = '';
    for (let i = offset; i < end; i++) {
      const code = input[i];
      if (code > 0x7f) {
        result = undefined;
        break;
      }
      result += String.fromCharCode(code);
    }
  }
  if (result === undefined) {
    const bytes = input.subarray(offset, end);
    result = isAscii(bytes) ? bytes.toString('latin1') : isUtf8(bytes) ? bytes.toString('utf8') : readInvalidUTF8(bytes);
  }
  offset = end;
  return result;
}

// What the browser's JSON conversion makes of bytes that are not UTF-8 (crdtp's json.cc,
// HandleString8): it skips a byte that cannot start a sequence, a sequence cut short by the end,
// one with a byte that does not continue it, and overlong forms of ASCII; it keeps surrogates.
function readInvalidUTF8(bytes: Buffer): string {
  let result = '';
  for (let i = 0; i < bytes.length; i++) {
    let c = bytes[i];
    if (c < 0x80) {
      result += String.fromCharCode(c);
      continue;
    }
    let codepoint: number;
    let left: number;
    if ((c & 0xe0) === 0xc0) {
      left = 1;
      codepoint = c & 0x1f;
    } else if ((c & 0xf0) === 0xe0) {
      left = 2;
      codepoint = c & 0x0f;
    } else if ((c & 0xf8) === 0xf0) {
      left = 3;
      codepoint = c & 0x07;
    } else {
      continue;
    }
    if (i + left >= bytes.length)
      continue;
    let invalid = false;
    while (left > 0) {
      c = bytes[++i];
      --left;
      if ((c & 0xc0) !== 0x80)
        invalid = true;
      codepoint = (codepoint << 6) | (c & 0x3f);
    }
    if (invalid || codepoint <= 0x7f || codepoint > 0x10ffff)
      continue;
    if (codepoint <= 0xffff) {
      result += String.fromCharCode(codepoint);
    } else {
      codepoint -= 0x10000;
      result += String.fromCharCode((codepoint >> 10) + 0xd800, (codepoint & 0x3ff) + 0xdc00);
    }
  }
  return result;
}

function readValue(depth: number): any {
  if (depth > kStackLimit)
    throw new StackLimitExceeded(offset);
  const initial = input[offset++];
  const major = initial >> 5;
  const info = initial & 31;
  switch (major) {
    case kMajorUnsigned:
      return readLength(info);
    case kMajorNegative:
      return -1 - readLength(info);
    case kMajorByteString: {
      // Without a tag, a byte string is a string outside ASCII, in UTF-16.
      const length = readLength(info);
      const result = input.toString('utf16le', offset, offset + length);
      offset += length;
      return result;
    }
    case kMajorString:
      return readString(readLength(info));
    case 4: {
      const result = [];
      while (input[offset] !== 0xff)
        result.push(readValue(depth + 1));
      offset++;
      return result;
    }
    case 5: {
      const result: any = {};
      while (input[offset] !== 0xff) {
        // Keys are strings, read without the depth check, as crdtp does.
        const key = readValue(0);
        const value = readValue(depth + 1);
        // As JSON.parse() does, `__proto__` is a property like any other.
        if (key === '__proto__')
          Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
        else
          result[key] = value;
      }
      offset++;
      return result;
    }
    case 6: {
      const tag = readLength(info);
      if (tag === kTagEnvelope) {
        readLength(input[offset++] & 31);
        return readValue(depth);
      }
      if (tag === kTagBase64) {
        const length = readLength(input[offset++] & 31);
        const result = input.toString('base64', offset, offset + length);
        offset += length;
        return result;
      }
      return readValue(depth);
    }
    default: {
      if (info === 20)
        return false;
      if (info === 21)
        return true;
      if (info === 22 || info === 23)
        return null;
      if (info === 27) {
        const value = input.readDoubleBE(offset);
        offset += 8;
        return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
      }
      if (info === 26) {
        const value = input.readFloatBE(offset);
        offset += 4;
        return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
      }
      throw new Error('Unsupported CBOR value');
    }
  }
}

export function decodeCBORMessage(buffer: Buffer): any {
  input = buffer;
  offset = 0;
  try {
    return readValue(0);
  } catch (error) {
    if (!(error instanceof StackLimitExceeded))
      throw error;
    return stackLimitExceededMessage(error.position);
  } finally {
    input = undefined!;
  }
}

// The error response the renderer sends instead of a response it cannot convert to JSON. An event
// it cannot convert crashes the renderer; one that arrives here is given as it is.
function stackLimitExceededMessage(position: number): any {
  const message: any = {};
  offset = 0;
  readLength(input[offset++] & 31);
  readLength(input[offset++] & 31);
  offset++;
  while (input[offset] !== 0xff) {
    const key = readValue(0);
    if (key === 'id' || key === 'sessionId')
      message[key] = readValue(0);
    else
      skipValue();
  }
  if (message.id === undefined) {
    offset = 0;
    return readValue(-Infinity);
  }
  const error = { code: -32000, message: `Failed to convert response to JSON: CBOR: stack limit exceeded at position ${position}` };
  return message.sessionId === undefined ? { id: message.id, error } : { id: message.id, error, sessionId: message.sessionId };
}

// Skips a value; a map or an array is skipped by the length of its envelope.
function skipValue() {
  const initial = input[offset++];
  const major = initial >> 5;
  const info = initial & 31;
  if (major === kMajorUnsigned || major === kMajorNegative) {
    readLength(info);
  } else if (major === kMajorByteString || major === kMajorString) {
    // Not `offset += readLength(info)`: that adds to the offset from before the length was read.
    const length = readLength(info);
    offset += length;
  } else if (major === 6) {
    readLength(info);
    skipValue();
  } else if (major === 4 || major === 5) {
    while (input[offset] !== 0xff)
      skipValue();
    offset++;
  } else if (info === 25) {
    offset += 2;
  } else if (info === 26) {
    offset += 4;
  } else if (info === 27) {
    offset += 8;
  }
}
