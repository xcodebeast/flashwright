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


// Flashwright: runtime entry for lib/coreBundle.js. coreBundle.ts stays the type source; this
// entry exposes the same names but initializes each part on first access, so a test run does not
// pay for the CLI, trace tools, MCP server or remote servers it never touches.

export {};

// esbuild replaces module.exports with its own object for this module; define the getters there.
function lazy(name: string, load: () => unknown) {
  const target = module.exports;
  Object.defineProperty(target, name, {
    enumerable: true,
    configurable: true,
    get() {
      const value = load();
      Object.defineProperty(target, name, { enumerable: true, value });
      return value;
    },
  });
}

lazy('iso', () => require('@isomorphic/index'));
lazy('utils', () => require('@utils/index'));
lazy('clientEventEmitter', () => require('./client/eventEmitter').EventEmitter);
lazy('libCli', () => require('./cli/program'));
lazy('libCliTestStub', () => require('./cli/programWithTestStub'));
lazy('inprocess', () => require('./inprocess'));
lazy('oop', () => require('./outofprocess'));
lazy('remote', () => require('./remote/playwrightServer'));
lazy('registry', () => require('./server/registry/index'));
lazy('server', () => require('./server/index'));
lazy('tools', () => require('./tools'));
lazy('getUserAgent', () => require('./server/userAgent').getUserAgent);
lazy('getPlaywrightVersion', () => require('./server/userAgent').getPlaywrightVersion);
