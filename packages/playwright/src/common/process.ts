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

import { processExit } from 'playwright-core/lib/bootstrap';

import { ManualPromise } from '@isomorphic/manualPromise';
import { setTimeOrigin } from '@isomorphic/time';
import { setBoxedStackPrefixes } from '@utils/stackTrace';

import { forgetLane, laneById, runInLane } from '../globals';
import { installLaneEnv } from './laneEnv';
import { packageRoot } from '../package';
import { serializeError } from '../util';

import type { EnvProducedPayload, ProcessInitParams, TestInfoErrorPayload } from './ipc';

export type ProtocolRequest = {
  id: number;
  method: string;
  params?: any;
};

export type ProtocolResponse = {
  id?: number;
  error?: TestInfoErrorPayload;
  method?: string;
  params?: any;
  result?: any;
};

export class ProcessRunner {
  // Flashwright: the lane this runner runs in, when the process runs several (see config.workersPerProcess).
  lane: number | undefined;

  async gracefullyClose(): Promise<void> { }

  // Flashwright: see WorkerMain.canDetachTeardown.
  canDetachTeardown(): boolean {
    return false;
  }

  protected dispatchEvent(method: string, params: any) {
    const response: ProtocolResponse = { method, params };
    sendMessageToParent({ method: '__dispatch__', params: response, lane: this.lane });
  }

  protected async sendRequest(method: string, params?: any): Promise<any> {
    return await sendRequestToParent(method, params, this.lane);
  }

  protected async sendMessageNoReply(method: string, params?: any) {
    void sendRequestToParent(method, params, this.lane).catch(() => {});
  }
}

let gracefullyCloseCalled = false;
let forceExitInitiated = false;

let processRunner: ProcessRunner | undefined;
// Flashwright: the runners of a process that runs several lanes, by lane.
const laneRunners = new Map<number, { runner: ProcessRunner, lane: Parameters<typeof runInLane>[0] }>();
let initialized = false;
let startingEnv = { ...process.env };
// Flashwright: a process whose process.exit was replaced may never exit (see canDetachTeardown).
// eslint-disable-next-line no-restricted-properties
export const originalProcessExit = process.exit;
setBoxedStackPrefixes([packageRoot]);

export function startProcessRunner(create: (params: any) => ProcessRunner) {
  sendMessageToParent({ method: 'ready' });

  process.on('disconnect', () => gracefullyCloseAndExit(true));
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});

  process.on('message', async (message: any) => {
    if (message.method === '__init__') {
      const { processParams, runnerParams } = message.params as { processParams: ProcessInitParams, runnerParams: any };
      if (!initialized) {
        initialized = true;
        setTimeOrigin(processParams.timeOrigin);
        if (processParams.env)
          adoptEnvironment(processParams.env);
        if (processParams.cwd && processParams.cwd !== process.cwd())
          process.chdir(processParams.cwd);
      }
      if (message.lane === undefined) {
        processRunner = create(runnerParams);
        return;
      }
      installLaneEnv();
      const lane = laneById(message.lane);
      const runner = runInLane(lane, () => create(runnerParams));
      runner.lane = message.lane;
      laneRunners.set(message.lane, { runner, lane });
      return;
    }
    if (message.method === '__stop__' && message.lane !== undefined) {
      const entry = laneRunners.get(message.lane);
      sendMessageToParent({ method: '__env_produced__', params: runInLane(laneById(message.lane), producedEnv), lane: message.lane });
      // Flashwright: see WorkerMain.canDetachTeardown.
      if (entry?.runner.canDetachTeardown()) {
        sendMessageToParent({ method: '__teardown_detached__', lane: message.lane });
        (globalThis as any)[Symbol.for('flashwright.codeCache')]?.refreshAtExit();
      }
      const heartbeat = realSetInterval(() => sendMessageToParent({ method: '__heartbeat__', lane: message.lane }), kHeartbeatInterval);
      heartbeat.unref();
      await runInLane(laneById(message.lane), async () => await entry?.runner.gracefullyClose()).catch(() => {});
      realClearInterval(heartbeat);
      laneRunners.delete(message.lane);
      forgetLane(message.lane);
      sendMessageToParent({ method: '__lane_closed__', lane: message.lane });
      return;
    }
    if (message.method === '__exit__') {
      // eslint-disable-next-line no-restricted-syntax
      processExit(0);
      return;
    }
    if (message.method === '__stop__') {
      sendMessageToParent({ method: '__env_produced__', params: producedEnv() });
      // Flashwright: tells the runner that it may finish without waiting for this process.
      if (processRunner?.canDetachTeardown()) {
        sendMessageToParent({ method: '__teardown_detached__' });
        // Nothing waits for this process to exit: it can bring its compiled code up to date.
        (globalThis as any)[Symbol.for('flashwright.codeCache')]?.refreshAtExit();
      }
      await gracefullyCloseAndExit(false);
      return;
    }
    if (message.method === '__dispatch__') {
      const { id, method, params } = message.params as ProtocolRequest;
      const entry = message.lane === undefined ? undefined : laneRunners.get(message.lane);
      try {
        const result = entry ? await runInLane(entry.lane, () => (entry.runner as any)[method](params)) : await (processRunner as any)[method](params);
        const response: ProtocolResponse = { id, result };
        sendMessageToParent({ method: '__dispatch__', params: response, lane: message.lane });
      } catch (e) {
        const response: ProtocolResponse = { id, error: serializeError(e) };
        sendMessageToParent({ method: '__dispatch__', params: response, lane: message.lane });
      }
    }
    if (message.method === '__response__')
      handleResponseFromParent(message.params as ProtocolResponse);
  });
}

function producedEnv(): EnvProducedPayload {
  const keys = new Set([...Object.keys(process.env), ...Object.keys(startingEnv)]);
  return [...keys].filter(key => startingEnv[key] !== process.env[key]).map(key => [key, process.env[key] ?? null]);
}

// A process started ahead of time takes the environment the runner computed for it.
function adoptEnvironment(env: Record<string, string | undefined>) {
  for (const key of Object.keys(process.env)) {
    if (!(key in env))
      delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined)
      delete process.env[key];
    else if (process.env[key] !== value)
      process.env[key] = value;
  }
  startingEnv = { ...process.env };
}

const kForceExitTimeout = +(process.env.PWTEST_FORCE_EXIT_TIMEOUT || 30000);
// Flashwright: a test running in another lane may have installed fake timers.
const { setInterval: realSetInterval, clearInterval: realClearInterval } = globalThis;
const kHeartbeatInterval = 1000;

async function gracefullyCloseAndExit(forceExit: boolean) {
  if (forceExit && !forceExitInitiated) {
    forceExitInitiated = true;
    // Force exit after 30 seconds.
    // eslint-disable-next-line no-restricted-syntax
    setTimeout(() => processExit(0), kForceExitTimeout);
  }
  if (!gracefullyCloseCalled) {
    gracefullyCloseCalled = true;
    // Heartbeats tell the parent that graceful close is still running, e.g. a fixture
    // teardown with "timeout: 0", as opposed to a hung process that must be force-killed.
    const heartbeat = setInterval(() => sendMessageToParent({ method: '__heartbeat__' }), kHeartbeatInterval);
    heartbeat.unref();
    // Meanwhile, try to gracefully shutdown.
    await processRunner?.gracefullyClose().catch(() => {});
    for (const { runner, lane } of laneRunners.values())
      await runInLane(lane, () => runner.gracefullyClose()).catch(() => {});
    clearInterval(heartbeat);
    // eslint-disable-next-line no-restricted-syntax
    processExit(0);
  }
}

function sendMessageToParent(message: { method: string, params?: any, lane?: number }) {
  try {
    process.send!(message);
  } catch (e) {
    try {
      // By default, the IPC messages are serialized as JSON.
      JSON.stringify(message);
    } catch {
      // Always throw serialization errors.
      throw e;
    }
    // Can throw when closing.
  }
}

let lastId = 0;
const requestCallbacks = new Map<number, ManualPromise<any>>();

async function sendRequestToParent(method: string, params?: any, lane?: number): Promise<any> {
  const id = ++lastId;
  sendMessageToParent({ method: '__request__', params: { id, method, params }, lane });
  const promise = new ManualPromise<any>();
  requestCallbacks.set(id, promise);
  return promise;
}

function handleResponseFromParent(response: ProtocolResponse) {
  const promise = requestCallbacks.get(response.id!);
  if (!promise)
    return;
  requestCallbacks.delete(response.id!);
  if (response.error)
    promise.reject(new Error(response.error.message));
  else
    promise.resolve(response.result);
}
