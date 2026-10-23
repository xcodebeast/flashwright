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

// Flashwright: opt-in warm session for repeated `playwright test` runs (FLASHWRIGHT_SESSION=1),
// such as an agent re-running a test after each change.
//
// The session is a background process, one per user, project directory and Flashwright install.
// It keeps a runner process ready, with Node started, the runner's modules and @playwright/test
// loaded and its workers started, and hands it the next run's arguments, working directory,
// environment and terminal. That process runs the one command exactly like the CLI would and
// exits; its output and exit code are relayed to the `playwright test` process that asked for the
// run, which stays in the foreground. Every run still gets fresh runner and worker processes, so
// nothing that the config or a test file loads outlives its run.
//
// What does outlive the run is the browser. A worker of a session run hands its browser to the
// session when it exits, instead of closing it: the recycled context, reset as between two tests,
// and the renderer that already compiled the application (see playwright-core's
// browserHandoff.ts). The next run's workers take these browsers over, so their first test starts
// as warm as the second test of a run.
//
// A ready process is only used when nothing that matters while modules load differs: the
// environment (apart from a few shell bookkeeping variables), Node binary and flags, the
// Flashwright build and the terminal (TTY size, stdin TTY). Otherwise the command runs normally
// and the session prepares a matching process for the next time. The session exits after 15
// minutes without runs, or when the Flashwright build it was started from changes.
//
// Keep this module free of heavy imports: the CLI loads it before everything else.

// This module is the terminal side of a run in the session: it relays the run's output and exits
// with it.
/* eslint-disable no-restricted-properties */

import child_process from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import url from 'url';

type Profile = {
  // `${columns}x${rows}` when stdout is a terminal, 'false' otherwise.
  stdout: string;
  stdinTTY: boolean;
};

type RunRequest = {
  type: 'run';
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  execPath: string;
  execArgv: string[];
  cliPath: string;
  build: string;
  profile: Profile;
};

type Hooks = {
  installCodeCache: (role: 'runner' | 'cli') => void;
  prespawnWorkers: (argv: string[]) => void;
  retargetWorkers: (argv: string[]) => void;
  loadProgram: () => { parse: (argv: string[]) => unknown };
  runCliClient: () => void;
};

// A browser on its way between processes: playwright-core's BrowserHandoff, with its two pipes
// sent as separate messages (one handle per message).
type BrowserMessage = {
  method: typeof kBrowserMessage;
  params: { id: string, part?: 'write' | 'read', metadata?: BrowserMetadata, none?: boolean };
};

type BrowserMetadata = { pid: number, tempDirectories: string[], lastUsed?: number };

type Browser = {
  id: string;
  write: net.Socket;
  read: net.Socket;
  metadata: BrowserMetadata;
};

// FLASHWRIGHT_SESSION_TIMEOUT sets it in seconds.
const kIdleTimeout = (Number(process.env.FLASHWRIGHT_SESSION_TIMEOUT) || 15 * 60) * 1000;
// Shell bookkeeping that changes between otherwise identical invocations.
const kVolatileEnv = new Set(['_', 'PWD', 'OLDPWD', 'SHLVL', 'COLUMNS', 'LINES']);
const kInteractiveArgs = ['--ui', '--ui-host', '--ui-port', '--debug', '--list', '-h', '--help'];
const kBrowserMessage = '__flashwright_browser__';
const kBrowserRequest = '__flashwright_browser_request__';
// Asks a worker started ahead of time for its browser, which it confirms after sending it.
const kReturnBrowser = '__flashwright_return_browser__';
const kBrowserReturned = '__flashwright_browser_returned__';
// Browsers kept per kind of run, at most; a session runs one project.
const kMaxBrowsers = 8;

// Entry point of the playwright and @playwright/test CLIs.
export function runCli(argv: string[], hooks: Hooks) {
  if (argv[2] === 'cli') {
    hooks.installCodeCache('cli');
    hooks.runCliClient();
    return;
  }
  if (process.env.FLASHWRIGHT_SESSION_ROLE === 'warm') {
    runWarmProcess(hooks).catch(error => {
      process.stderr.write(`Flashwright session: ${error.stack || error}\n`);
      process.exit(1);
    });
    return;
  }
  if (argv[2] === 'test' && sessionRequested() && !argv.some(arg => kInteractiveArgs.includes(arg.split('=')[0]))) {
    const request = createRequest(argv);
    runInSession(request).then(outcome => runLocally(argv, hooks, outcome === 'start' ? request : undefined), () => runLocally(argv, hooks));
    return;
  }
  runLocally(argv, hooks);
}

function runLocally(argv: string[], hooks: Hooks, startSessionWith?: RunRequest) {
  hooks.installCodeCache(argv[2] === 'test' ? 'runner' : 'cli');
  // The workers of this run already hand their browsers to the session it starts.
  if (startSessionWith)
    startSession(startSessionWith);
  if (argv[2] === 'test')
    hooks.prespawnWorkers(argv);
  hooks.loadProgram().parse(argv);
}

function sessionRequested() {
  const value = process.env.FLASHWRIGHT_SESSION;
  return !!value && value !== '0' && value !== 'false' && !process.env.PWDEBUG && process.platform !== 'win32';
}

function buildStamp(): string {
  // The bundles a runner process loads; a rebuild or reinstall changes their size or time.
  const files = ['program.js', 'common/index.js', 'runner/index.js', 'runner/session.js', 'worker/workerProcessEntry.js'].map(file => path.join(__dirname, '..', file));
  try {
    files.push(require.resolve('playwright-core/lib/coreBundle'));
  } catch {
  }
  return files.map(file => {
    try {
      const stat = fs.statSync(file);
      return `${file}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return file;
    }
  }).join('|');
}

function terminalProfile(): Profile {
  return {
    stdout: process.stdout.isTTY ? `${process.stdout.columns || 0}x${process.stdout.rows || 0}` : 'false',
    stdinTTY: !!process.stdin.isTTY,
  };
}

function stableEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !kVolatileEnv.has(key) && !key.startsWith('FLASHWRIGHT_SESSION_'))
      result[key] = value;
  }
  return result;
}

function createRequest(argv: string[]): RunRequest {
  return {
    type: 'run',
    argv,
    cwd: process.cwd(),
    env: stableEnv(process.env),
    execPath: process.execPath,
    execArgv: process.execArgv,
    cliPath: argv[1],
    build: buildStamp(),
    profile: terminalProfile(),
  };
}

function warmKey(request: RunRequest): string {
  const env = Object.entries(stableEnv(request.env)).sort(([a], [b]) => a < b ? -1 : 1);
  return crypto.createHash('sha1').update(JSON.stringify([env, request.execPath, request.execArgv, request.cliPath, request.build, request.profile])).digest('hex');
}

// One session per user, project directory and install, in a directory only this user can use.
function sessionSocketPath(cwd: string): string | undefined {
  const uid = os.userInfo().uid;
  const directory = path.join(os.tmpdir(), `flashwright-${uid}`);
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch {
  }
  try {
    const stat = fs.statSync(directory);
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077))
      return;
  } catch {
    return;
  }
  const id = crypto.createHash('sha1').update([path.join(__dirname, '..'), process.execPath, cwd].join('\0')).digest('hex').slice(0, 16);
  const socketFile = path.join(directory, `session-${id}.sock`);
  // Socket paths are limited to about a hundred bytes.
  return Buffer.byteLength(socketFile) < 100 ? socketFile : undefined;
}

// --- The `playwright test` process that asks for a run. ---

// 'start': no session yet, run here and start one; 'local': run here.
function runInSession(request: RunRequest): Promise<'start' | 'local'> {
  const socketFile = sessionSocketPath(request.cwd);
  if (!socketFile)
    return Promise.resolve('local');
  return new Promise(resolve => {
    const socket = net.connect(socketFile);
    let started = false;
    let exited = false;
    let buffer = '';
    const lost = () => {
      process.stderr.write('Flashwright session: the connection to the test run was lost.\n');
      process.exit(1);
    };
    socket.on('error', () => {
      if (started)
        lost();
      else
        resolve('start');
    });
    // Once the run started here, this process exits with it.
    socket.on('close', () => {
      if (!started)
        resolve('local');
      else if (!exited)
        lost();
    });
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.type === 'cold') {
          socket.destroy();
          resolve(message.stale ? 'start' : 'local');
        } else if (message.type === 'started') {
          started = true;
          // The run stops like it would here; a second Ctrl+C leaves it to the session.
          let interrupted = false;
          for (const signal of ['SIGINT', 'SIGTERM'] as const) {
            process.on(signal, () => {
              if (interrupted)
                process.exit(130);
              interrupted = true;
              socket.write(JSON.stringify({ type: 'signal', signal }) + '\n');
            });
          }
        } else if (message.type === 'stdout' || message.type === 'stderr') {
          (message.type === 'stdout' ? process.stdout : process.stderr).write(Buffer.from(message.data, 'base64'));
        } else if (message.type === 'exit') {
          exited = true;
          socket.destroy();
          const code = message.code ?? (message.signal === 'SIGINT' ? 130 : 1);
          // Let the relayed output drain before exiting.
          process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
        }
      }
    });
  });
}

// Started by a run that found no session. The session prepares a runner for the next run once
// this one is over, and takes the browsers this run's workers hand over.
function startSession(request: RunRequest) {
  const socketFile = sessionSocketPath(request.cwd);
  if (!socketFile)
    return;
  const child = child_process.spawn(process.execPath, [__filename, '--flashwright-session', socketFile, request.build], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, FLASHWRIGHT_SESSION_ROLE: 'session' },
  });
  child.on('error', () => {});
  child.unref();
  (child as any).channel?.unref?.();
  child.send({ method: 'request', params: request });
  joinSession(child, false);
}

// --- Runner processes of a session: the warm runner, or the run that started the session. ---

type Channel = {
  send(message: any, handle?: any, callback?: (error: Error | null) => void): boolean;
  readonly connected: boolean;
  disconnect(): void;
};

let sessionChannel: Channel | undefined;
let offersBrowsers = false;
let lastRequestId = 0;
const standbyRequests = new Map<string, child_process.ChildProcess>();
const workerParts = new Map<string, Partial<Browser>>();
const pendingSends = new Set<Promise<void>>();
const sessionWorkers = new Set<child_process.ChildProcess>();
// Workers started ahead of time that no test has used yet.
const sessionStandbys = new Set<child_process.ChildProcess>();

function joinSession(channel: Channel, offers: boolean) {
  sessionChannel = channel;
  offersBrowsers = offers;
  // Workers hand their browsers to this process when they exit.
  process.env.FLASHWRIGHT_SESSION_HANDOFF = '1';
}

// Called for each worker the runner starts ahead of time: in a warm runner, the session may have a
// browser for it. The worker waits for the answer before it launches one (see speculativeBrowser.ts).
export function sessionStandbyEnv(): Record<string, string> {
  return offersBrowsers && sessionChannel?.connected ? { FLASHWRIGHT_SESSION_OFFER: '1' } : {};
}

export function requestSessionBrowser(child: child_process.ChildProcess) {
  if (!sessionChannel)
    return;
  sessionStandbys.add(child);
  child.once('exit', () => sessionStandbys.delete(child));
  if (!offersBrowsers || !sessionChannel.connected)
    return;
  const id = String(++lastRequestId);
  standbyRequests.set(id, child);
  child.once('exit', () => standbyRequests.delete(id));
  sessionChannel.send({ method: kBrowserRequest, params: { id } });
}

// Called by ProcessHost for every message of a worker; true when the message was a browser
// handed over to the session.
export function receiveWorkerMessage(child: child_process.ChildProcess, message: any, handle: any): boolean {
  if (message?.method !== kBrowserMessage)
    return false;
  const browser = collectBrowserPart(workerParts, message, handle);
  if (browser)
    forwardBrowser(browser);
  return true;
}

// Called by ProcessHost for every worker it starts.
export function trackSessionWorker(child: child_process.ChildProcess) {
  if (!sessionChannel)
    return;
  sessionStandbys.delete(child);
  sessionWorkers.add(child);
  child.once('disconnect', () => sessionWorkers.delete(child));
}

function forwardBrowser(browser: Browser) {
  if (!sessionChannel?.connected || browser.read.readableLength) {
    killBrowser(browser);
    return;
  }
  pendingSends.add(sendBrowser(sessionChannel, browser));
}

// Called before the runner exits: its workers' browsers must reach the session first. A worker
// sends its browser before it exits, so everything it sent has arrived once its channel closed.
// A warm runner also tells the session its exit code, so that the `playwright test` process can
// exit without waiting for this one to be torn down.
export async function flushSessionBrowsers(exitCode?: number) {
  if (!sessionChannel)
    return;
  // Workers started ahead of time that no test used hold a browser too.
  await Promise.all([...sessionStandbys].map(returnStandbyBrowser));
  const deadline = Date.now() + 2000;
  while (sessionWorkers.size && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 5));
  await Promise.all(pendingSends);
  for (const parts of workerParts.values())
    killBrowser(parts);
  workerParts.clear();
  if (outputBytes && exitCode !== undefined && sessionChannel.connected)
    await new Promise(resolve => sessionChannel!.send({ type: 'exiting', code: exitCode, ...outputBytes }, undefined, resolve));
  if (sessionChannel.connected)
    sessionChannel.disconnect();
}

// Bytes a warm runner wrote to its output, which the session relays (see flushSessionBrowsers).
let outputBytes: { stdout: number, stderr: number } | undefined;

function countOutputBytes() {
  outputBytes = { stdout: 0, stderr: 0 };
  for (const name of ['stdout', 'stderr'] as const) {
    const stream = process[name];
    const write = stream.write;
    stream.write = function(this: any, chunk: any, encoding?: any, callback?: any) {
      outputBytes![name] += typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8') : chunk.length;
      return (write as any).apply(this, arguments);
    } as typeof stream.write;
  }
}

function returnStandbyBrowser(child: child_process.ChildProcess): Promise<void> {
  if (!child.connected)
    return Promise.resolve();
  return new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      resolve();
    };
    const timer = setTimeout(done, 2000);
    const onMessage = (message: any, handle: any) => {
      if (message?.method === kBrowserReturned)
        done();
      else if (message?.method === kBrowserMessage)
        receiveWorkerMessage(child, message, handle);
    };
    child.on('message', onMessage);
    child.once('exit', done);
    child.send({ method: kReturnBrowser });
  });
}

function onSessionMessage(message: any, handle: any) {
  if (message?.method !== kBrowserMessage)
    return;
  const child = standbyRequests.get(message.params.id);
  if (message.params.part !== 'write')
    standbyRequests.delete(message.params.id);
  if (child?.connected) {
    child.send(message, handle);
    return;
  }
  // The worker it was for is gone: the browser goes back.
  const browser = collectBrowserPart(workerParts, message, handle);
  if (browser)
    forwardBrowser(browser);
}

// --- Moving browsers between processes. ---

function collectBrowserPart(parts: Map<string, Partial<Browser>>, message: BrowserMessage, handle: any): Browser | undefined {
  const { id, part, metadata } = message.params;
  if (!part || !handle)
    return;
  const browser = parts.get(id) ?? { id };
  browser[part] = handle;
  if (metadata)
    browser.metadata = metadata;
  parts.set(id, browser);
  if (!browser.write || !browser.read || !browser.metadata)
    return;
  parts.delete(id);
  return browser as Browser;
}

function sendBrowser(channel: Channel, browser: Browser): Promise<void> {
  const { id, metadata } = browser;
  return new Promise<void>(resolve => {
    channel.send({ method: kBrowserMessage, params: { id, part: 'write', metadata } }, browser.write, error => {
      if (error) {
        killBrowser(browser);
        resolve();
        return;
      }
      channel.send({ method: kBrowserMessage, params: { id, part: 'read' } }, browser.read, () => resolve());
    });
  });
}

function killBrowser(browser: Partial<Browser>) {
  browser.write?.destroy();
  browser.read?.destroy();
  if (!browser.metadata)
    return;
  try {
    process.kill(-browser.metadata.pid, 'SIGKILL');
  } catch {
  }
  // Its profile goes once the browser has let go of it.
  const directories = browser.metadata.tempDirectories;
  setTimeout(() => {
    for (const directory of directories)
      fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }, () => {});
  }, 500).unref();
}

// --- The session. ---

type WarmProcess = {
  child: child_process.ChildProcess;
  key: string;
  ready: Promise<boolean>;
  running: boolean;
  // Until its channel closes, a running runner may still hand over its workers' browsers.
  connected: boolean;
  parts: Map<string, Partial<Browser>>;
  exiting?: (message: { code: number, stdout: number, stderr: number }) => void;
};

type PooledBrowser = Browser & { key: string };

function runSession(socketFile: string, build: string) {
  const warmProcesses: WarmProcess[] = [];
  const browsers: PooledBrowser[] = [];
  // Requests of a warm runner waiting for a browser that a running run will hand over.
  const waiting: { warm: WarmProcess, id: string }[] = [];
  // The kind of run of the run that started the session, until it is over.
  let startingRunKey: string | undefined;
  let lastRequest: RunRequest | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let activeRuns = 0;

  const shutdown = () => {
    for (const warm of warmProcesses.splice(0))
      warm.child.kill();
    for (const browser of browsers.splice(0))
      killBrowser(browser);
    server.close();
    try {
      fs.unlinkSync(socketFile);
    } catch {
    }
    process.exit(0);
  };
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!activeRuns)
        shutdown();
    }, kIdleTimeout);
  };

  const runsThatMayHandOver = (key: string) => (startingRunKey === key ? 1 : 0) + warmProcesses.filter(warm => warm.running && warm.connected && warm.key === key).length;

  const answer = (warm: WarmProcess, id: string) => {
    // The browser that ran tests most recently has the most of the application compiled.
    let browser: PooledBrowser | undefined;
    for (const candidate of browsers) {
      if (candidate.key === warm.key && (!browser || (candidate.metadata.lastUsed ?? 0) > (browser.metadata.lastUsed ?? 0)))
        browser = candidate;
    }
    if (browser)
      remove(browser);
    if (!warm.child.connected) {
      if (browser)
        browsers.push(browser);
      return;
    }
    if (!browser) {
      warm.child.send({ method: kBrowserMessage, params: { id, none: true } });
      return;
    }
    browser.read.removeAllListeners('data');
    browser.read.removeAllListeners('close');
    browser.read.pause();
    void sendBrowser(warm.child, { ...browser, id });
  };

  const onBrowserRequest = (warm: WarmProcess, id: string) => {
    if (browsers.some(browser => browser.key === warm.key) || warm.running || !runsThatMayHandOver(warm.key))
      answer(warm, id);
    else
      waiting.push({ warm, id });
  };

  const answerWaiting = (predicate: (entry: { warm: WarmProcess, id: string }) => boolean) => {
    for (const entry of waiting.filter(predicate)) {
      waiting.splice(waiting.indexOf(entry), 1);
      answer(entry.warm, entry.id);
    }
  };

  const onBrowserReturned = (key: string, browser: Browser) => {
    // Anything the browser sends while nobody uses it would be lost for its next user.
    if (browser.read.readableLength) {
      killBrowser(browser);
      return;
    }
    const pooled: PooledBrowser = { ...browser, key };
    browser.read.on('data', () => {
      remove(pooled);
      killBrowser(pooled);
    });
    browser.read.on('close', () => {
      remove(pooled);
      killBrowser(pooled);
    });
    browsers.push(pooled);
    const entry = waiting.find(entry => entry.warm.key === key);
    if (entry) {
      waiting.splice(waiting.indexOf(entry), 1);
      answer(entry.warm, entry.id);
    }
    // Too many: the ones that ran tests longest ago go.
    const sameKind = browsers.filter(browser => browser.key === key).sort((a, b) => (a.metadata.lastUsed ?? 0) - (b.metadata.lastUsed ?? 0));
    for (const extra of sameKind.slice(0, Math.max(0, sameKind.length - kMaxBrowsers))) {
      remove(extra);
      killBrowser(extra);
    }
  };
  const remove = (browser: PooledBrowser) => {
    const index = browsers.indexOf(browser);
    if (index !== -1)
      browsers.splice(index, 1);
  };

  const spawnWarm = (request: RunRequest) => {
    const key = warmKey(request);
    if (warmProcesses.some(warm => warm.key === key && !warm.running))
      return;
    // Prepare it as if for the same command, so that its workers match the project.
    // It starts a worker for each browser the session holds, so that none of them waits unused.
    const standbys = browsers.filter(browser => browser.key === key).length;
    const child = child_process.spawn(request.execPath, [...request.execArgv, request.cliPath, ...request.argv.slice(2)], {
      cwd: request.cwd,
      env: { ...warmEnv(request), FLASHWRIGHT_SESSION_ROLE: 'warm', FLASHWRIGHT_SESSION_STANDBYS: String(standbys) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const warm: WarmProcess = { child, key, ready: Promise.resolve(false), running: false, connected: true, parts: new Map() };
    warm.ready = new Promise<boolean>(resolve => {
      child.on('message', (message: any, handle: any) => {
        if (message?.type === 'warm') {
          resolve(true);
        } else if (message?.type === 'exiting') {
          warm.exiting?.(message);
        } else if (message?.method === kBrowserRequest) {
          onBrowserRequest(warm, message.params.id);
        } else if (message?.method === kBrowserMessage) {
          const browser = collectBrowserPart(warm.parts, message, handle);
          if (browser)
            onBrowserReturned(key, browser);
        }
      });
      child.once('exit', () => resolve(false));
    });
    warmProcesses.push(warm);
    // Everything it sent has arrived once its channel closes.
    child.once('disconnect', () => {
      warm.connected = false;
      for (const parts of warm.parts.values())
        killBrowser(parts);
      warm.parts.clear();
      answerWaiting(entry => entry.warm === warm || !runsThatMayHandOver(entry.warm.key));
    });
    child.once('exit', () => {
      const index = warmProcesses.indexOf(warm);
      if (index !== -1)
        warmProcesses.splice(index, 1);
    });
  };

  const handle = async (socket: net.Socket, request: RunRequest) => {
    resetIdleTimer();
    if (request.build !== build) {
      // Flashwright was rebuilt or reinstalled: this session runs stale code.
      socket.end(JSON.stringify({ type: 'cold', stale: true }) + '\n');
      shutdown();
      return;
    }
    lastRequest = request;
    const key = warmKey(request);
    const index = warmProcesses.findIndex(warm => warm.key === key && !warm.running);
    const warm = index === -1 ? undefined : warmProcesses[index];
    if (!warm || !await warm.ready) {
      warm?.child.kill();
      socket.end(JSON.stringify({ type: 'cold' }) + '\n');
      if (!startingRunKey)
        spawnWarm(request);
      return;
    }

    activeRuns++;
    warm.running = true;
    // The run starts now: browsers that are not here yet will not be waited for.
    answerWaiting(entry => entry.warm === warm);
    const send = (message: object) => {
      if (!socket.destroyed)
        socket.write(JSON.stringify(message) + '\n');
    };
    send({ type: 'started' });
    // The runner reports its exit code before it exits, with the bytes it wrote: once they are
    // relayed, the client can exit.
    const relayed = { stdout: 0, stderr: 0 };
    let exiting: { code: number, stdout: number, stderr: number } | undefined;
    let finished = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished)
        return;
      finished = true;
      send({ type: 'exit', code, signal });
      socket.end();
    };
    const finishIfRelayed = () => {
      if (exiting && relayed.stdout >= exiting.stdout && relayed.stderr >= exiting.stderr)
        finish(exiting.code, null);
    };
    warm.exiting = message => {
      exiting = message;
      finishIfRelayed();
    };
    for (const name of ['stdout', 'stderr'] as const) {
      warm.child[name]!.on('data', (data: Buffer) => {
        send({ type: name, data: data.toString('base64') });
        relayed[name] += data.length;
        finishIfRelayed();
      });
    }
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.type === 'signal')
          warm.child.kill(message.signal);
      }
    });
    // The client went away (killed, terminal closed): stop its run like Ctrl+C would.
    socket.on('close', () => {
      if (warm.child.exitCode === null && warm.child.signalCode === null)
        warm.child.kill('SIGINT');
    });
    warm.child.once('exit', (code, signal) => {
      activeRuns--;
      resetIdleTimer();
      // Output events are delivered before 'close'; wait for it so that nothing is cut off.
      if (warm.child.stdout!.readableEnded && warm.child.stderr!.readableEnded)
        finish(code, signal);
      else
        warm.child.once('close', () => finish(code, signal));
      // Prepare the next one now that this run no longer needs the CPU.
      spawnWarm(lastRequest ?? request);
    });
    warm.child.send(request);
  };

  // A session that is already running (started by a concurrent run) keeps the socket.
  const listen = () => server.listen(socketFile, () => fs.chmodSync(socketFile, 0o600));
  const server = net.createServer(socket => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline === -1)
        return;
      socket.off('data', onData);
      const request = JSON.parse(buffer.slice(0, newline)) as RunRequest;
      handle(socket, request).catch(() => socket.destroy());
    };
    socket.on('data', onData);
    socket.on('error', () => {});
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EADDRINUSE')
      process.exit(0);
    const probe = net.connect(socketFile);
    probe.on('connect', () => process.exit(0));
    probe.on('error', () => {
      try {
        fs.unlinkSync(socketFile);
      } catch {
      }
      listen();
    });
  });
  listen();
  resetIdleTimer();
  process.on('SIGTERM', shutdown);

  // The run that started the session: its request, then its workers' browsers.
  const parts = new Map<string, Partial<Browser>>();
  process.on('message', (message: any, handle: any) => {
    if (message?.method === 'request') {
      lastRequest = message.params;
      startingRunKey = warmKey(message.params);
    } else if (message?.method === kBrowserMessage && startingRunKey) {
      const browser = collectBrowserPart(parts, message, handle);
      if (browser)
        onBrowserReturned(startingRunKey, browser);
    }
  });
  process.on('disconnect', () => {
    for (const browser of parts.values())
      killBrowser(browser);
    parts.clear();
    startingRunKey = undefined;
    if (lastRequest)
      spawnWarm(lastRequest);
  });
}

// The environment a warm process loads its modules with: the run's, plus what makes the modules
// see the run's terminal. Both are taken out again when the run starts.
function warmEnv(request: RunRequest): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...request.env };
  const injected: string[] = [];
  if (request.profile.stdout !== 'false') {
    for (const [key, value] of [['PLAYWRIGHT_FORCE_TTY', request.profile.stdout], ['FORCE_COLOR', '1']]) {
      if (env[key] === undefined) {
        env[key] = value;
        injected.push(key);
      }
    }
  }
  env.FLASHWRIGHT_SESSION_INJECTED = injected.join(',');
  return env;
}

// --- A warm runner process. ---

async function runWarmProcess(hooks: Hooks) {
  joinSession(process as Channel, true);
  process.on('message', onSessionMessage);
  // Load everything a run of this command needs before it is asked for. The reporters decide on
  // colors and terminal size while they load, so they load with the run's terminal profile.
  hooks.installCodeCache('runner');
  const program = hooks.loadProgram();
  require(path.join(__dirname, 'index.js'));
  // Configs and test files import @playwright/test, which is playwright/test. Its ES module entry
  // also creates the in-process library, which takes a while.
  const packageRoot = path.join(__dirname, '..', '..');
  require(path.join(packageRoot, 'test.js'));
  await import(url.pathToFileURL(path.join(packageRoot, 'test.mjs')).href).catch(() => {});
  await import(url.pathToFileURL(path.join(path.dirname(process.argv[1]), 'index.mjs')).href).catch(() => {});
  for (const key of (process.env.FLASHWRIGHT_SESSION_INJECTED || '').split(',').filter(Boolean))
    delete process.env[key];
  delete process.env.FLASHWRIGHT_SESSION_INJECTED;
  delete process.env.FLASHWRIGHT_SESSION_ROLE;
  hooks.prespawnWorkers(process.argv);
  const request = await new Promise<RunRequest>(resolve => {
    const onMessage = (message: any) => {
      if (message?.type !== 'run')
        return;
      process.off('message', onMessage);
      resolve(message);
    };
    process.on('message', onMessage);
    process.send!({ type: 'warm' });
  });
  process.channel?.unref();

  // Become the process the user started.
  process.chdir(request.cwd);
  for (const key of Object.keys(process.env)) {
    if (!(key in request.env) && key !== 'FLASHWRIGHT_SESSION_HANDOFF')
      delete process.env[key];
  }
  Object.assign(process.env, request.env);
  process.argv = request.argv;
  if (request.profile.stdout !== 'false') {
    const [columns, rows] = request.profile.stdout.split('x').map(Number);
    Object.assign(process.stdout, { isTTY: true, columns, rows });
  }
  if (request.profile.stdinTTY)
    Object.assign(process.stdin, { isTTY: true });
  countOutputBytes();
  hooks.retargetWorkers(request.argv);
  program.parse(request.argv);
}

if (process.argv[2] === '--flashwright-session')
  runSession(process.argv[3], process.argv[4]);
