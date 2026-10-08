import { failure } from './errors.js';

interface IncomingAttachment {
  encoding: 'raw' | 'base64';
  byteLength: number;
  encodedLength: number;
  encodedReceived: number;
  decodedReceived: number;
  buffer: Buffer | undefined;
}

function corrupt(message: string): never {
  throw failure('ProtocolError', 'protocol.attachment', message);
}

/** Allocate once, copy bounded chunks, and expose bytes only after complete terminal delivery. */
export class AttachmentReceiver {
  private readonly active = new Map<number, IncomingAttachment>();
  constructor(private readonly maximumBytes: number, private readonly maximumActive: number) {}

  begin(requestId: number, encoding: unknown, byteLength: unknown, encodedLength: unknown, discard: boolean): void {
    if (this.active.has(requestId)) corrupt('duplicate attachment start');
    if (this.active.size >= this.maximumActive) corrupt('too many active attachments');
    if (encoding !== 'raw' && encoding !== 'base64') corrupt('unknown attachment encoding');
    if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > this.maximumBytes) corrupt('invalid attachment byte length');
    const expectedLength = encoding === 'raw' ? byteLength : Math.ceil(byteLength / 3) * 4;
    if (encodedLength !== expectedLength) corrupt('invalid encoded attachment length');
    this.active.set(requestId, { encoding, byteLength, encodedLength: expectedLength, encodedReceived: 0, decodedReceived: 0, buffer: discard ? undefined : Buffer.allocUnsafe(byteLength) });
  }

  receive(frame: Buffer): void {
    if (frame.length <= 13 || frame.length > 13 + 64 * 1024 || frame[0] !== 0) corrupt('invalid attachment chunk size or marker');
    const identity = frame.readBigUInt64LE(1);
    if (identity === 0n || identity > BigInt(Number.MAX_SAFE_INTEGER)) corrupt('invalid attachment request identity');
    const attachment = this.active.get(Number(identity));
    if (!attachment) corrupt('attachment chunk has no active request');
    if (frame.readUInt32LE(9) !== attachment.encodedReceived) corrupt('attachment offset is out of order');
    const bytes = frame.subarray(13);
    const encodedEnd = attachment.encodedReceived + bytes.length;
    if (encodedEnd > attachment.encodedLength) corrupt('attachment exceeds its declared length');
    let decodedLength = bytes.length;
    if (attachment.encoding === 'base64') {
      const encoded = bytes.toString('latin1');
      if (bytes.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) corrupt('invalid base64 attachment chunk');
      const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
      if (padding && encodedEnd !== attachment.encodedLength) corrupt('base64 padding before the final chunk');
      const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(encoded[encoded.length - padding - 1]!);
      if (last < 0 || (padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) corrupt('noncanonical base64 attachment padding');
      decodedLength = bytes.length / 4 * 3 - padding;
      if (attachment.decodedReceived + decodedLength > attachment.byteLength) corrupt('decoded attachment exceeds its declared length');
      if (attachment.buffer && attachment.buffer.write(encoded, attachment.decodedReceived, decodedLength, 'base64') !== decodedLength) corrupt('incomplete base64 chunk decoding');
    } else if (attachment.buffer) {
      bytes.copy(attachment.buffer, attachment.decodedReceived);
    }
    attachment.encodedReceived = encodedEnd;
    attachment.decodedReceived += decodedLength;
  }

  finish(requestId: number, byteLength: unknown): Buffer | undefined {
    const attachment = this.active.get(requestId);
    if (!attachment || byteLength !== attachment.byteLength || attachment.encodedReceived !== attachment.encodedLength || attachment.decodedReceived !== attachment.byteLength) corrupt('incomplete attachment terminal result');
    this.active.delete(requestId);
    return attachment.buffer;
  }

  /** A deadline releases retained bytes while late chunks still undergo framing checks. */
  expire(requestId: number): void {
    const attachment = this.active.get(requestId);
    if (attachment) attachment.buffer = undefined;
  }

  discard(requestId: number): void { this.active.delete(requestId); }
  clear(): void { this.active.clear(); }
}
