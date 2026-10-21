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

const pwt = require('./lib/index');

// Flashwright: the library half of these exports (browser types, devices, request, ...) starts an
// in-process Playwright with its server when first created. The test runner's own process loads
// this module for every config and test file but rarely touches the library, so it is created on
// first access instead. Workers create it as soon as the browser fixtures run.
let playwright;
const library = () => playwright ??= require('./index');
const libraryKeys = ['request', 'chromium', 'firefox', 'webkit', '_android', '_electron', 'devices', 'selectors', 'errors'];

const exported = pwt.test;
for (const key of libraryKeys) {
  if (key in pwt)
    continue;
  Object.defineProperty(exported, key, {
    enumerable: true,
    configurable: true,
    get: () => library()[key],
    set: value => Object.defineProperty(exported, key, { enumerable: true, configurable: true, writable: true, value }),
  });
}
Object.assign(exported, pwt);

module.exports = exported;
