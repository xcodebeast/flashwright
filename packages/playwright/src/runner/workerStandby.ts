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

// Flashwright: start worker processes while the CLI is still loading its own code, the config
// and the test files. A standby worker loads Playwright and launches the default browser in
// parallel, and is configured later through the usual __init__ message. The number of standbys
// is remembered from the previous run of the same project. Keep this module free of heavy
// imports: it runs before the rest of the CLI loads.

import child_process from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

type Standby = {
  child: child_process.ChildProcess;
  entryScript: string;
  env: NodeJS.ProcessEnv;
  ready: Promise<boolean>;
};

const standbys: Standby[] = [];
let enabled = false;
let hintFile: string | undefined;
let workerCount = 0;

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
  if (enabled || argv[2] !== 'test' || process.env.PW_DISABLE_WORKER_STANDBY || process.env.PWDEBUG)
    return;
  const interactive = ['--list', '--ui', '--ui-host', '--ui-port', '--debug', '-h', '--help', '--last-failed'];
  if (argv.some(arg => interactive.includes(arg.split('=')[0])))
    return;
  enabled = true;
  hintFile = workerCountHintFile(argv);
  const cpus = os.availableParallelism?.() ?? os.cpus().length;
  const count = Math.max(1, Math.min(readWorkerCountHint(), cpus));
  for (let i = 0; i < count; i++)
    spawnStandby();
  process.once('exit', () => {
    discardStandbys();
    writeWorkerCountHint();
  });
}

function spawnStandby() {
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
  standbys.push({ child, entryScript, env, ready });
  // Never keep the runner alive for a standby that was not used.
  child.unref();
  (child as any).channel?.unref?.();
}

// Called when a worker had to be replaced after a failure while tests remain: keep one standby
// ready so the next replacement does not pay for a cold start.
export function ensureSpareStandby() {
  if (enabled && !standbys.length)
    spawnStandby();
}

// Remembers how many workers the run starts, for the next run's pre-spawn.
export function recordWorkerCount(count: number) {
  workerCount = Math.max(workerCount, count);
}

export function discardStandbys() {
  for (const standby of standbys.splice(0))
    release(standby.child);
}

// Workers ignore SIGTERM; closing the IPC channel makes them shut down gracefully, browser included.
function release(child: child_process.ChildProcess) {
  if (child.connected)
    child.disconnect();
}

// Hands out a standby process if one was started for the same entry script and nothing that
// matters at module-load time has changed since.
export async function takeStandby(entryScript: string, env: NodeJS.ProcessEnv): Promise<child_process.ChildProcess | undefined> {
  const standby = standbys.shift();
  if (!standby)
    return;
  const keys = new Set([...Object.keys(env), ...Object.keys(standby.env)]);
  const compatible = standby.entryScript === entryScript && [...keys].every(key => !loadTimeEnvPattern.test(key) || env[key] === standby.env[key]);
  if (!compatible || !await standby.ready) {
    release(standby.child);
    return;
  }
  standby.child.ref();
  (standby.child as any).channel?.ref?.();
  return standby.child;
}

function workerCountHintFile(argv: string[]) {
  const configIndex = argv.findIndex(arg => arg === '-c' || arg === '--config' || arg.startsWith('--config='));
  const config = configIndex === -1 ? '' : argv[configIndex].startsWith('--config=') ? argv[configIndex] : argv[configIndex + 1];
  const workers = argv.find(arg => arg.startsWith('--workers') || arg === '-j') ?? '';
  const key = crypto.createHash('sha1').update([process.cwd(), config, workers].join('\0')).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'flashwright', `workers-${key}.json`);
}

function readWorkerCountHint(): number {
  try {
    return Number(JSON.parse(fs.readFileSync(hintFile!, 'utf8')).workers) || 1;
  } catch {
    return 1;
  }
}

function writeWorkerCountHint() {
  if (!workerCount)
    return;
  try {
    fs.mkdirSync(path.dirname(hintFile!), { recursive: true });
    fs.writeFileSync(hintFile!, JSON.stringify({ workers: workerCount }));
  } catch {
  }
}
