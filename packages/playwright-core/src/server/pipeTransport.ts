/**
 * Copyright 2018 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { debugLogger } from '@utils/debugLogger';

import { cborMessageSize, decodeCBORMessage, encodeCBORMessage } from './cborCodec';

import type { ConnectionTransport, ProtocolRequest, ProtocolResponse } from './transport';

export class PipeTransport implements ConnectionTransport {
  private _pipeRead: NodeJS.ReadableStream;
  private _pipeWrite: NodeJS.WritableStream;
  private _pendingBuffers: Buffer[] = [];
  private _pendingLength = 0;
  private _closed = false;
  // Flashwright: Chromium's protocol as CBOR (--remote-debugging-pipe=cbor), see cborCodec.ts.
  readonly cbor: boolean;
  private _onclose?: (reason?: string) => void;

  onmessage?: (message: ProtocolResponse) => void;

  constructor(pipeWrite: NodeJS.WritableStream, pipeRead: NodeJS.ReadableStream, cbor = false) {
    this._pipeRead = pipeRead;
    this._pipeWrite = pipeWrite;
    this.cbor = cbor;
    pipeRead.on('data', buffer => cbor ? this._dispatchCBOR(buffer) : this._dispatch(buffer));
    pipeRead.on('close', () => {
      this._closed = true;
      if (this._onclose)
        this._onclose.call(null);
    });
    pipeRead.on('error', e => debugLogger.log('error', e));
    pipeWrite.on('error', e => debugLogger.log('error', e));
    this.onmessage = undefined;
  }

  get onclose() {
    return this._onclose;
  }

  set onclose(onclose: undefined | ((reason?: string) => void)) {
    this._onclose = onclose;
    if (onclose && !this._pipeRead.readable)
      onclose();
  }

  send(message: ProtocolRequest) {
    if (this._closed)
      throw new Error('Pipe has been closed');
    // Flashwright: one write per message instead of two.
    this._pipeWrite.write(this.cbor ? encodeCBORMessage(message) : JSON.stringify(message) + '\0');
  }

  close() {
    throw new Error('unimplemented');
  }

  // Flashwright: stops reading and gives the pipes to another owner, who continues the stream of
  // messages (see browserHandoff.ts). Only possible between two messages: returns undefined when
  // part of one has already been read.
  release(): { write: NodeJS.WritableStream, read: NodeJS.ReadableStream, cbor: boolean } | undefined {
    if (this._closed || this._pendingBuffers.some(buffer => buffer.length))
      return;
    this._closed = true;
    this._pipeRead.removeAllListeners('data');
    this._pipeRead.removeAllListeners('close');
    this._pipeRead.pause();
    return { write: this._pipeWrite, read: this._pipeRead, cbor: this.cbor };
  }

  _dispatchCBOR(buffer: Buffer) {
    this._pendingBuffers.push(buffer);
    this._pendingLength += buffer.length;
    while (true) {
      let head = this._pendingBuffers[0];
      if (this._pendingLength < 7)
        return;
      if (head.length < 7)
        this._pendingBuffers = [head = Buffer.concat(this._pendingBuffers, this._pendingLength)];
      const size = cborMessageSize(head)!;
      if (this._pendingLength < size)
        return;
      // A message that came in several chunks is joined once, when its last chunk has arrived.
      const all = this._pendingBuffers.length === 1 ? head : Buffer.concat(this._pendingBuffers, this._pendingLength);
      const message = all.subarray(0, size);
      setImmediate(() => {
        if (this.onmessage)
          this.onmessage.call(null, decodeCBORMessage(message));
      });
      const rest = all.subarray(size);
      this._pendingBuffers = rest.length ? [rest] : [];
      this._pendingLength = rest.length;
    }
  }

  _dispatch(buffer: Buffer) {
    let end = buffer.indexOf('\0');
    if (end === -1) {
      this._pendingBuffers.push(buffer);
      return;
    }
    this._pendingBuffers.push(buffer.slice(0, end));
    const message = Buffer.concat(this._pendingBuffers).toString();
    setImmediate(() => {
      if (this.onmessage)
        this.onmessage.call(null, JSON.parse(message));
    });

    let start = end + 1;
    end = buffer.indexOf('\0', start);
    while (end !== -1) {
      const message = buffer.toString(undefined, start, end);
      setImmediate(() => {
        if (this.onmessage)
          this.onmessage.call(null, JSON.parse(message));
      });
      start = end + 1;
      end = buffer.indexOf('\0', start);
    }
    this._pendingBuffers = [buffer.slice(start)];
  }
}
