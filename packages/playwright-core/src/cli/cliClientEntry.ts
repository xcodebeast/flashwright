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

// Flashwright: `playwright cli <command>` forwards a command to a browser session. Agents run it
// for every step, so the CLI entry points call this directly instead of loading every command
// (and the in-process server) first. Behaves like the `cli` command of the full program.

import { gracefullyProcessExitDoNotHang } from '@utils/processLauncher';

import { program } from '../tools/cli-client/program';

export function runCliClient() {
  process.argv.splice(process.argv.indexOf('cli'), 1);
  program().catch((e: Error) => {
    /* eslint-disable no-console */
    if (process.env.PWDEBUGIMPL)
      console.error(e);
    else
      console.error(e.name + ': ' + e.message);
    /* eslint-enable no-console */
    gracefullyProcessExitDoNotHang(1);
  });
}
