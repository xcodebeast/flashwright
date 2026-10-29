/**
 * Copyright Microsoft Corporation. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import child_process from 'child_process';
import { EventEmitter } from 'events';

import debug from 'debug';
import { assert } from '@isomorphic/assert';
import { monotonicTime, timeOrigin } from '@isomorphic/time';
import { raceAgainstDeadline } from '@isomorphic/timeoutRunner';
import { ManualPromise } from '@isomorphic/manualPromise';
import { killProcessTree } from '@utils/processLauncher';
import { takeStandby } from './workerStandby';
import { receiveWorkerMessage, trackDetachedTeardown, trackSessionWorker } from './session';

import type { ipc, processRunner } from '../common';

export type ProcessExitData = {
  unexpectedly: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
};

// Flashwright: with config.workersPerProcess, a worker process runs several workers at once, each
// in a lane of its own with its own browser, sharing the process and the code it loaded. The
// process exits once its last lane has stopped.
export type LaneOptions = {
  // Workers that may share the process.
  perProcess: number;
  // Only workers of one project share a process: some of what projects configure, like the test id
  // attribute, applies to the whole process.
  projectId: string;
};

type SharedProcess = {
  process?: child_process.ChildProcess;
  entryScript: string;
  projectId: string;
  capacity: number;
  lanes: Set<number>;
  nextLane: number;
  exiting: boolean;
  // Resolves once the first lane's runner was initialized, false if the process did not start.
  started: ManualPromise<boolean>;
};
const sharedProcesses: SharedProcess[] = [];

export class ProcessHost extends EventEmitter {
  private process: child_process.ChildProcess | undefined;
  private _didSendStop = false;
  private _processDidExit = false;
  private _didExitAndRanOnExit = false;
  private _entryScript: string;
  private _lastMessageId = 0;
  private _callbacks = new Map<number, { resolve: (result: any) => void, reject: (error: Error) => void }>();
  private _processName: string;
  private _producedEnv: Record<string, string | undefined> = {};
  private _extraEnv: Record<string, string | undefined>;
  private _requestHandlers = new Map<string, (params: any) => Promise<any>>();
  // Flashwright: resolved when a stopping worker says that it can finish on its own (see stop).
  private _teardownDetached = new ManualPromise<boolean>();
  private _shared: SharedProcess | undefined;
  private _lane: number | undefined;
  private _laneOptions: LaneOptions | undefined;

  constructor(entryScript: string, processName: string, env: Record<string, string | undefined>, laneOptions?: LaneOptions) {
    super();
    this._entryScript = entryScript;
    this._processName = processName;
    this._extraEnv = env;
    this._laneOptions = laneOptions;
  }

  async startRunner(runnerParams: any, options: { onStdOut?: (chunk: Buffer | string) => void, onStdErr?: (chunk: Buffer | string) => void } = {}): Promise<ProcessExitData | undefined> {
    assert(!this.process, 'Internal error: starting the same process twice');
    const laneOptions = this._laneOptions;
    if (laneOptions && laneOptions.perProcess > 1) {
      const shared = sharedProcesses.find(p => p.entryScript === this._entryScript && p.projectId === laneOptions.projectId && !p.exiting && p.lanes.size < p.capacity);
      if (shared)
        return await this._startLane(shared, runnerParams);
      this._shared = { entryScript: this._entryScript, projectId: laneOptions.projectId, capacity: laneOptions.perProcess, lanes: new Set([0]), nextLane: 1, exiting: false, started: new ManualPromise() };
      this._lane = 0;
      sharedProcesses.push(this._shared);
    }
    const result = await this._startProcess(runnerParams, options);
    this._shared?.started.resolve(!result);
    return result;
  }

  private async _startLane(shared: SharedProcess, runnerParams: any): Promise<ProcessExitData | undefined> {
    this._shared = shared;
    this._lane = shared.nextLane++;
    shared.lanes.add(this._lane);
    if (!await shared.started) {
      shared.lanes.delete(this._lane);
      return { unexpectedly: true, code: null, signal: null };
    }
    this.process = shared.process!;
    this._listen();
    const processParams: ipc.ProcessInitParams = { timeOrigin: timeOrigin() };
    this.send({ method: '__init__', params: { processParams, runnerParams } });
  }

  private async _startProcess(runnerParams: any, options: { onStdOut?: (chunk: Buffer | string) => void, onStdErr?: (chunk: Buffer | string) => void }): Promise<ProcessExitData | undefined> {
    const env = {
      ...process.env,
      ...this._extraEnv,
    };
    // Flashwright: reuse a worker process that was started while the CLI was loading.
    const pipesOutput = !!options.onStdOut && !!options.onStdErr && !process.env.PW_RUNNER_DEBUG;
    const adopted = pipesOutput ? await takeStandby(this._entryScript, env) : undefined;
    this.process = adopted ?? child_process.fork(this._entryScript, {
      // Note: we pass detached:false, so that workers are in the same process group.
      // This way Ctrl+C or a kill command can shutdown all workers in case they misbehave.
      // Otherwise user can end up with a bunch of workers stuck in a busy loop without self-destructing.
      detached: false,
      env,
      stdio: [
        'ignore',
        options.onStdOut ? 'pipe' : 'inherit',
        (options.onStdErr && !process.env.PW_RUNNER_DEBUG) ? 'pipe' : 'inherit',
        'ipc',
      ],
    });
    if (this._shared) {
      const shared = this._shared;
      shared.process = this.process;
      this.process.once('exit', () => {
        shared.exiting = true;
        if (sharedProcesses.includes(shared))
          sharedProcesses.splice(sharedProcesses.indexOf(shared), 1);
      });
    }
    this.process.on('error', e => {});  // do not yell at a send to dead process.
    // Flashwright: in a warm session, workers hand their browsers over through this process.
    trackSessionWorker(this.process);
    this._listen();

    if (options.onStdOut)
      this.process.stdout?.on('data', options.onStdOut);
    if (options.onStdErr)
      this.process.stderr?.on('data', options.onStdErr);

    if (!adopted) {
      const error = await new Promise<ProcessExitData | undefined>(resolve => {
        this.process!.once('exit', (code, signal) => resolve({ unexpectedly: true, code, signal }));
        this.once('ready', () => resolve(undefined));
      });

      if (error)
        return error;
    }

    const processParams: ipc.ProcessInitParams = {
      timeOrigin: timeOrigin(),
      ...(adopted ? { env, cwd: process.cwd() } : {}),
    };

    this.send({
      method: '__init__', params: {
        processParams,
        runnerParams
      }
    });
  }

  private _listen() {
    this.process!.on('exit', async (code, signal) => {
      if (this._didExitAndRanOnExit || this._processDidExit)
        return;
      this._processDidExit = true;
      await this.onExit();
      this._didExitAndRanOnExit = true;
      this.emit('exit', { unexpectedly: !this._didSendStop, code, signal } as ProcessExitData);
    });
    this.process!.on('message', (message: any, handle: any) => {
      if (receiveWorkerMessage(this.process!, message, handle))
        return;
      if (this._shared && (message.lane ?? 0) !== this._lane)
        return;
      if (debug.enabled('pw:test:protocol'))
        debug('pw:test:protocol')('◀ RECV ' + JSON.stringify(message));
      if (message.method === '__lane_closed__') {
        void this._laneClosed();
      } else if (message.method === '__teardown_detached__') {
        this._teardownDetached.resolve(true);
      } else if (message.method === '__env_produced__') {
        const producedEnv: ipc.EnvProducedPayload = message.params;
        this._producedEnv = Object.fromEntries(producedEnv.map(e => [e[0], e[1] ?? undefined]));
      } else if (message.method === '__dispatch__') {
        const { id, error, method, params, result } = message.params as processRunner.ProtocolResponse;
        if (id && this._callbacks.has(id)) {
          const { resolve, reject } = this._callbacks.get(id)!;
          this._callbacks.delete(id);
          if (error) {
            const errorObject = new Error(error.message);
            errorObject.stack = error.stack;
            reject(errorObject);
          } else {
            resolve(result);
          }
        } else {
          this.emit(method!, params);
        }
      } else if (message.method === '__request__') {
        const { id, method, params } = message.params as processRunner.ProtocolRequest;
        const handler = this._requestHandlers.get(method);
        if (!handler) {
          this.send({ method: '__response__', params: { id, error: { message: 'Unknown method' } } });
        } else {
          handler(params).then(result => {
            this.send({ method: '__response__', params: { id, result } });
          }).catch(error => {
            this.send({ method: '__response__', params: { id, error: { message: error.message } } });
          });
        }
      } else {
        this.emit(message.method!, message.params);
      }
    });
  }

  // The process stops when its last lane has; until then, a lane that stopped is done.
  private async _laneClosed() {
    const shared = this._shared!;
    shared.lanes.delete(this._lane!);
    if (!shared.lanes.size) {
      shared.exiting = true;
      sharedProcesses.splice(sharedProcesses.indexOf(shared), 1);
      this.process?.send({ method: '__exit__' });
      return;
    }
    this._processDidExit = true;
    this._didExitAndRanOnExit = true;
    // What the lane leaves behind goes when the process exits: the browser that its lanes share
    // writes into the folders of the lane that launched it.
    this.process?.once('exit', () => void this.onExit());
    this.emit('exit', { unexpectedly: false, code: 0, signal: null } as ProcessExitData);
  }

  sendMessage(message: { method: string, params?: any }) {
    const id = ++this._lastMessageId;
    this.send({
      method: '__dispatch__',
      params: { id, ...message }
    });
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, { resolve, reject });
    });
  }

  protected sendMessageNoReply(message: { method: string, params?: any }) {
    this.sendMessage(message).catch(() => {});
  }

  protected async onExit() {
  }

  onRequest(method: string, handler: (params?: any) => Promise<any>) {
    this._requestHandlers.set(method, handler);
  }

  // Flashwright: with `detachTeardown`, also returns once the process says that what it has left to
  // do cannot change the run's outcome (see WorkerMain.canDetachTeardown); the warm session's
  // runner waits for it to exit before it exits itself.
  async stop(options: { detachTeardown?: boolean } = {}) {
    if (!this._processDidExit && !this._didSendStop) {
      this.send({ method: '__stop__' });
      this._didSendStop = true;
    }
    if (this._didExitAndRanOnExit)
      return;
    const exited = new Promise<boolean>(f => this.once('exit', () => f(false)));
    const exitPromise = options.detachTeardown ? Promise.race([exited, this._teardownDetached]) : exited;
    const timeout = +(process.env.PWTEST_CHILD_PROCESS_TIMEOUT || 5 * 60 * 1000);
    // Child sends heartbeats while gracefully closing, e.g. running a slow fixture
    // teardown with "timeout: 0". Only force-kill when heartbeats stop coming.
    let lastHeartbeat = monotonicTime();
    const onHeartbeat = () => lastHeartbeat = monotonicTime();
    this.on('__heartbeat__', onHeartbeat);
    try {
      while (true) {
        const result = await raceAgainstDeadline(() => exitPromise, lastHeartbeat + timeout);
        if (!result.timedOut) {
          if (result.result)
            trackDetachedTeardown(exited);
          return;
        }
        if (monotonicTime() < lastHeartbeat + timeout)
          continue;
        this.emit('processError', { message: `Error: ${this._processName} process did not exit within ${timeout}ms after stop, force-killed it` });
        this._forceKill();
        await exitPromise;
        return;
      }
    } finally {
      this.off('__heartbeat__', onHeartbeat);
    }
  }

  private _forceKill() {
    if (this.process?.pid)
      killProcessTree(this.process.pid);
  }

  didSendStop() {
    return this._didSendStop;
  }

  producedEnv() {
    return this._producedEnv;
  }

  private send(message: { method: string, params?: any }) {
    if (debug.enabled('pw:test:protocol'))
      debug('pw:test:protocol')('SEND ► ' + JSON.stringify(message));
    this.process?.send(this._lane === undefined ? message : { ...message, lane: this._lane });
  }
}
