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

// Flashwright: start the first worker process while the CLI is still loading its own code,
// the config and the test files. The worker loads Playwright in parallel and is configured
// later through the usual __init__ message. Keep this module free of heavy imports: it runs
// before the rest of the CLI loads.

import child_process from 'child_process';
import path from 'path';

type Standby = {
  child: child_process.ChildProcess;
  entryScript: string;
  env: NodeJS.ProcessEnv;
  ready: Promise<boolean>;
};

let standby: Standby | undefined;

// Variables that change how Playwright or Node behave while modules load. A standby worker
// started with different values cannot be reconfigured after the fact.
const loadTimeEnvPattern = /^(PW|PLAYWRIGHT|DEBUG|NODE|FORCE_COLOR|TS_NODE|TSX)/;

export function workerEntryScript() {
  return path.join(__dirname, '..', 'worker', 'workerProcessEntry.js');
}

export function workerEnv(extraEnv: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extraEnv,
    FORCE_COLOR: '1',
    DEBUG_COLORS: process.env.DEBUG_COLORS === undefined ? '1' : process.env.DEBUG_COLORS,
  };
}

export function prespawnWorkerForTestCommand(argv: string[]) {
  if (standby || argv[2] !== 'test' || process.env.PW_DISABLE_WORKER_STANDBY)
    return;
  const interactive = ['--list', '--ui', '--ui-host', '--ui-port', '--debug', '-h', '--help', '--last-failed'];
  if (argv.some(arg => interactive.includes(arg.split('=')[0])))
    return;
  const entryScript = workerEntryScript();
  // The test runner marks its process tree with PLAYWRIGHT_TEST before starting workers.
  const env = { ...workerEnv({}), PLAYWRIGHT_TEST: '1', FLASHWRIGHT_SPECULATIVE_BROWSER: '1' };
  const child = child_process.fork(entryScript, {
    detached: false,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.on('error', () => {});
  const ready = new Promise<boolean>(resolve => {
    const onMessage = (message: any) => {
      if (message?.method === 'ready') {
        child.off('message', onMessage);
        resolve(true);
      }
    };
    child.on('message', onMessage);
    child.once('exit', () => resolve(false));
  });
  standby = { child, entryScript, env, ready };
  // Never keep the runner alive for a standby that was not used.
  child.unref();
  (child as any).channel?.unref?.();
  process.once('exit', () => discardStandby());
}

export function discardStandby() {
  const current = standby;
  standby = undefined;
  if (current)
    release(current.child);
}

// Workers ignore SIGTERM; closing the IPC channel makes them shut down gracefully, browser included.
function release(child: child_process.ChildProcess) {
  if (child.connected)
    child.disconnect();
}

// Hands out the standby process if it was started for the same entry script and nothing that
// matters at module-load time has changed since.
export async function takeStandby(entryScript: string, env: NodeJS.ProcessEnv): Promise<child_process.ChildProcess | undefined> {
  const current = standby;
  if (!current)
    return;
  standby = undefined;
  const keys = new Set([...Object.keys(env), ...Object.keys(current.env)]);
  const compatible = current.entryScript === entryScript && [...keys].every(key => !loadTimeEnvPattern.test(key) || env[key] === current.env[key]);
  if (!compatible || !await current.ready) {
    release(current.child);
    return;
  }
  current.child.ref();
  (current.child as any).channel?.ref?.();
  return current.child;
}
