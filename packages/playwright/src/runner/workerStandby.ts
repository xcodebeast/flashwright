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
// is remembered from the previous run of the same project. Runs with failing tests replace
// workers, so once a run (or the previous run) had failures, one spare standby is kept ready
// while CPUs allow. Keep this module free of heavy imports: it runs before the rest of the CLI
// loads.

import child_process from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { requestSessionBrowser, sessionStandbyEnv } from './session';

type Standby = {
  child: child_process.ChildProcess;
  entryScript: string;
  env: NodeJS.ProcessEnv;
  ready: Promise<boolean>;
};

const standbys: Standby[] = [];
let enabled = false;
let hintKey: string | undefined;
let workerCount = 0;
let restartCount = 0;
let keepSpare = false;
let cpus = 1;
let hadHint = false;
// Workers that share a worker process (config.workersPerProcess): the previous run's until the
// config is loaded.
let workersPerProcess = 1;

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
  hintKey = workerCountHintKey(argv);
  // Workers and their browsers started ahead of time look up their config's hints by this key.
  process.env.FLASHWRIGHT_CONTEXT_HINT_KEY = hintKey;
  cpus = os.availableParallelism?.() ?? os.cpus().length;
  const hint = readWorkerCountHints()[hintKey];
  hadHint = !!hint;
  workersPerProcess = hint?.workersPerProcess ?? 1;
  // A runner that a warm session prepared also starts one for each browser the session holds: the
  // workers of a process share one.
  const sessionBrowsers = Number(process.env.FLASHWRIGHT_SESSION_STANDBYS) || 0;
  const count = Math.max(1, Math.min(Math.max(Math.ceil((hint?.workers || 1) / workersPerProcess), sessionBrowsers), cpus));
  keepSpare = !!hint?.restarts && count < cpus;
  for (let i = 0; i < count + (keepSpare ? 1 : 0); i++)
    spawnStandby();
  process.once('exit', () => {
    discardStandbys();
    writeWorkerCountHint();
  });
}

function spawnStandby(waitsForNextPhase = false) {
  const entryScript = workerEntryScript();
  // The test runner marks its process tree with PLAYWRIGHT_TEST before starting workers. A standby
  // for the next phase of projects knows it will wait, and prepares right away.
  const env = { ...workerEnv({}), PLAYWRIGHT_TEST: '1', FLASHWRIGHT_SPECULATIVE_BROWSER: waitsForNextPhase ? 'next-phase' : '1', ...sessionStandbyEnv() };
  const child = child_process.fork(entryScript, {
    detached: false,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.on('error', () => {});
  // In a warm session, the browser of a previous run may be waiting for it (see session.ts).
  requestSessionBrowser(child);
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

// Called when a worker has to be replaced after a failure. Failures tend to repeat, so from now
// on one standby is kept ready for the next replacement while tests remain.
export function recordWorkerRestart(moreTestsToRun: boolean) {
  restartCount++;
  if (!moreTestsToRun)
    return;
  keepSpare = keepSpare || workerCount < cpus;
  // The replacement is about to take a standby; fork the next one after it has.
  setImmediate(() => ensureStandbys(1));
}

// Called while one phase of projects runs: the next phase starts new workers.
export function ensureStandbys(count: number, forNextPhase = false) {
  if (!enabled)
    return;
  while (standbys.length < Math.ceil(count / workersPerProcess))
    spawnStandby(forNextPhase);
}

// Called once the config is loaded. Without a hint from a previous run (a first run, or CI), start
// the configured number of workers now rather than when the first tests are dispatched.
export function ensureStandbysForConfig(configuredWorkers: number, configuredWorkersPerProcess: number) {
  workersPerProcess = configuredWorkersPerProcess;
  if (enabled && !hadHint)
    ensureStandbys(Math.min(configuredWorkers, cpus));
}

// A runner prepared ahead of time by a warm session learns its actual command late.
export function retargetStandbys(argv: string[]) {
  if (enabled)
    hintKey = workerCountHintKey(argv);
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
  // Forking takes milliseconds of this thread; let the adopted worker get its first messages before.
  if (keepSpare)
    setImmediate(() => ensureStandbys(1));
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

// All projects share one small hint file, keeping only the most recently used entries.
const hintFile = path.join(os.tmpdir(), 'flashwright-worker-hints.json');
const maxHints = 500;

function workerCountHintKey(argv: string[]) {
  const configIndex = argv.findIndex(arg => arg === '-c' || arg === '--config' || arg.startsWith('--config='));
  const config = configIndex === -1 ? '' : argv[configIndex].startsWith('--config=') ? argv[configIndex] : argv[configIndex + 1];
  const workers = argv.find(arg => arg.startsWith('--workers') || arg === '-j') ?? '';
  return crypto.createHash('sha1').update([process.cwd(), config, workers].join('\0')).digest('hex').slice(0, 16);
}

function readWorkerCountHints(): Record<string, { workers: number, restarts?: number, workersPerProcess?: number, usedAt: number }> {
  try {
    return JSON.parse(fs.readFileSync(hintFile, 'utf8'));
  } catch {
    return {};
  }
}

function writeWorkerCountHint() {
  if (!workerCount || !hintKey)
    return;
  try {
    const hints = readWorkerCountHints();
    hints[hintKey] = { workers: workerCount, restarts: restartCount, workersPerProcess, usedAt: Date.now() };
    const recent = Object.entries(hints).sort((a, b) => b[1].usedAt - a[1].usedAt).slice(0, maxHints);
    // Write a sibling file and rename it, so concurrent runs never read a partial file.
    const temporary = `${hintFile}.${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(recent)));
    fs.renameSync(temporary, hintFile);
  } catch {
  }
}
