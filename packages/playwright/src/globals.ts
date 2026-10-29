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

import { AsyncLocalStorage } from 'async_hooks';

import type { Suite } from './common/test';
import type { TestInfoImpl } from './worker/testInfo';

// Flashwright: with config.workersPerProcess, a worker process runs several workers at once, each in a
// lane of its own. Code that runs for a lane sees that lane's current test.
export type LaneEnv = { values: Map<string, string>, deleted: Set<string> };
export type Lane = { id: number, testInfo: TestInfoImpl | null, expectConfig?: unknown, worker?: unknown, playwrightOptions?: Record<string, unknown>, env?: LaneEnv };
const laneStorage = new AsyncLocalStorage<Lane>();

const lanes = new Map<number, Lane>();

// What the process starts for a lane before the lane itself, like its browser, runs in it too.
export function laneById(id: number): Lane {
  let lane = lanes.get(id);
  if (!lane) {
    lane = { id, testInfo: null };
    lanes.set(id, lane);
  }
  return lane;
}

export function forgetLane(id: number) {
  lanes.delete(id);
}

export function runInLane<T>(lane: Lane, fn: () => T): T {
  return laneStorage.run(lane, fn);
}

export function currentLane(): Lane | undefined {
  return laneStorage.getStore();
}

(globalThis as any)[Symbol.for('flashwright.lanes')] = { laneById, runInLane, currentLane };

// Returns a listener that only hears what the current lane does.
export function bindToCurrentLane<T extends object>(listener: T): T {
  const lane = laneStorage.getStore();
  if (!lane)
    return listener;
  const bound: any = {};
  for (const [name, fn] of Object.entries(listener))
    bound[name] = (...args: any[]) => laneStorage.getStore() === lane ? (fn as Function)(...args) : undefined;
  return bound;
}

let currentTestInfoValue: TestInfoImpl | null = null;
export function setCurrentTestInfo(testInfo: TestInfoImpl | null) {
  currentTestInfoValue = testInfo;
  const lane = laneStorage.getStore();
  if (lane)
    lane.testInfo = testInfo;
}
export function currentTestInfo(): TestInfoImpl | null {
  const lane = laneStorage.getStore();
  return lane ? lane.testInfo : currentTestInfoValue;
}

let currentFileSuite: Suite | undefined;
export function setCurrentlyLoadingFileSuite(suite: Suite | undefined) {
  currentFileSuite = suite;
}
export function currentlyLoadingFileSuite() {
  return currentFileSuite;
}

let _isWorkerProcess = false;

export function setIsWorkerProcess() {
  _isWorkerProcess = true;
}

export function isWorkerProcess() {
  return _isWorkerProcess;
}
