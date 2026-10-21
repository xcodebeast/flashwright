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

import { utilsFacade } from './generated/utilsFacade';

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

// The server modules form import cycles that only initialize correctly from the in-process
// entry point, which is also what the playwright-core package loads first.
const withServer = (load: () => unknown) => () => {
  require('./inprocess');
  return load();
};

lazy('iso', () => require('@isomorphic/index'));
// The runner destructures a few helpers from `utils` while it starts; each name loads only the
// module that defines it instead of the whole barrel.
lazy('utils', () => {
  const facade = {};
  for (const [names, load] of utilsFacade) {
    let module: any;
    for (const name of names)
      Object.defineProperty(facade, name, { enumerable: true, get: () => (module ??= load())[name] });
  }
  return facade;
});
lazy('clientEventEmitter', () => require('./client/eventEmitter').EventEmitter);
lazy('libCli', withServer(() => require('./cli/program')));
lazy('libCliTestStub', withServer(() => require('./cli/programWithTestStub')));
lazy('runCliClient', () => require('./cli/cliClientEntry').runCliClient);
lazy('inprocess', () => require('./inprocess'));
lazy('oop', withServer(() => require('./outofprocess')));
lazy('remote', withServer(() => require('./remote/playwrightServer')));
lazy('registry', withServer(() => require('./server/registry/index')));
lazy('server', withServer(() => require('./server/index')));
lazy('tools', withServer(() => require('./tools')));
lazy('getUserAgent', () => require('./server/userAgent').getUserAgent);
lazy('getPlaywrightVersion', () => require('./server/userAgent').getPlaywrightVersion);
