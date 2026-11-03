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

import { startProcessRunner, transform } from '../common';
import { create } from './loaderMain';

startProcessRunner(create);

// Flashwright: started ahead of a watch-mode run (see workerStandby.ts); a run's __init__ that
// arrives meanwhile waits for the warm-up, which it would otherwise do itself.
if (process.env.FLASHWRIGHT_LOADER_STANDBY) {
  delete process.env.FLASHWRIGHT_LOADER_STANDBY;
  setImmediate(() => {
    try {
      transform.warmUpTransform();
    } catch {
    }
  });
}
