#!/usr/bin/env node
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

// Flashwright: keep V8's compiled code for Playwright's own modules across runs. Setting the
// environment variable extends the cache to worker processes.
const nodeModule = require('module');
if (nodeModule.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  const { directory } = nodeModule.enableCompileCache();
  if (directory)
    process.env.NODE_COMPILE_CACHE = directory;
}

// Flashwright: start the first test worker while the CLI loads.
require('./lib/runner/workerStandby').prespawnWorkerForTestCommand(process.argv);
const { program } = require('./lib/program');
program.parse(process.argv);
