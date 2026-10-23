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

export class ProtocolError extends Error {
  type: 'error' | 'closed' | 'crashed';
  method: string | undefined;
  logs: string | undefined;

  constructor(type: 'error' | 'closed' | 'crashed', method?: string, logs?: string) {
    super();
    this.type = type;
    this.method = method;
    this.logs = logs;
  }

  // Flashwright: called once the browser answered with an error, before anything read this
  // error's stack. The stack is formatted with the current message when it is read, so it is not
  // formatted now: most of these errors are expected and never shown, and formatting a stack
  // through source map support takes milliseconds.
  setMessage(message: string) {
    this.message = `Protocol error (${this.method}): ${message}`;
  }

  browserLogMessage() {
    return this.logs ? '\nBrowser logs:\n' + this.logs : '';
  }
}

export function isProtocolError(e: Error): e is ProtocolError {
  return e instanceof ProtocolError;
}

export function isSessionClosedError(e: Error): e is ProtocolError {
  return e instanceof ProtocolError && (e.type === 'closed' || e.type === 'crashed');
}
