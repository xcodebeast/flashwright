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

// Flashwright: installs the code cache before the bundles below are compiled; keep it first.
import '../codeCache';
import path from 'path';

import { startProcessRunner } from '../common';
import { create } from './workerMain';
import { launchSpeculativeBrowser, prepareSpeculativeContext, returnSpeculativeBrowser } from '../speculativeBrowser';

// Flashwright: a worker started ahead of time also starts the default browser right away. A spare
// that then stays idle (one kept ready to replace a failed worker, or started for the next phase of
// projects) also loads the test runner's public module, which every config and test file imports
// (by path, so that the bundler leaves it out of this bundle), and prepares the context its first
// test is likely to ask for. A worker that is put to work right away does neither: its first test
// would wait for them.
const kSpareIdleTime = 100;
if (process.env.FLASHWRIGHT_SPECULATIVE_BROWSER) {
  let initialized = false;
  process.on('message', (message: any) => initialized ||= message?.method === '__init__');
  const idleTime = process.env.FLASHWRIGHT_SPECULATIVE_BROWSER === 'next-phase' ? 0 : kSpareIdleTime;
  // In a warm session, a runner that exits without using this worker takes its browser back.
  process.on('message', (message: any) => {
    if (message?.method === '__flashwright_return_browser__' && !initialized)
      void returnSpeculativeBrowser().finally(() => process.send?.({ method: '__flashwright_browser_returned__' }));
  });
  void launchSpeculativeBrowser().then(() => setTimeout(() => {
    if (initialized)
      return;
    try {
      require(path.join(__dirname, '..', '..', 'test.js'));
    } catch {
      // The config or test file that imports it reports the error.
    }
    if (!initialized)
      prepareSpeculativeContext();
  }, idleTime));
}
startProcessRunner(create);
