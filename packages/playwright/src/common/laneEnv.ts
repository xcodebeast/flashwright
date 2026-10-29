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

// Flashwright: with config.workersPerProcess, the workers of a process run in lanes of their own
// (see globals.ts). Each lane sees the process environment with its own changes on top: what its
// tests set, delete or replace in process.env, and the TEST_WORKER_INDEX and TEST_PARALLEL_INDEX
// its worker sets, stay the lane's, also for the processes its tests start. What the environment
// changes outside JavaScript stays the process's: a time zone set in TZ applies to every lane.

import { currentLane } from '../globals';

import type { LaneEnv } from '../globals';

// Setting these changes the process, not only what JavaScript reads.
const kProcessWide = new Set(['TZ']);
// Windows environment variable names are case-insensitive.
const normalize = process.platform === 'win32' ? (key: string) => key.toUpperCase() : (key: string) => key;

let installed = false;

export function installLaneEnv() {
  if (installed)
    return;
  installed = true;
  const base = process.env;

  const laneEnv = (key?: string): LaneEnv | undefined => {
    if (key !== undefined && kProcessWide.has(normalize(key)))
      return;
    const lane = currentLane();
    if (lane)
      lane.env ??= { values: new Map(), deleted: new Set() };
    return lane?.env;
  };

  const read = (key: string): string | undefined => {
    const env = laneEnv(key);
    const name = normalize(key);
    if (env?.values.has(name))
      return env.values.get(name);
    if (env?.deleted.has(name))
      return undefined;
    return base[key];
  };

  const write = (key: string, value: string) => {
    const env = laneEnv(key);
    if (!env) {
      base[key] = value;
      return;
    }
    env.values.set(normalize(key), value);
    env.deleted.delete(normalize(key));
  };

  const remove = (key: string) => {
    const env = laneEnv(key);
    if (!env) {
      delete base[key];
      return;
    }
    env.values.delete(normalize(key));
    env.deleted.add(normalize(key));
  };

  const keys = (): string[] => {
    const env = laneEnv();
    if (!env)
      return Object.keys(base);
    const result = Object.keys(base).filter(key => !env.deleted.has(normalize(key)) && !env.values.has(normalize(key)));
    return [...result, ...env.values.keys()];
  };

  // `process.env = { ... }` replaces what the lane sees.
  const replace = (value: Record<string, unknown>) => {
    const next = new Map(Object.entries(value ?? {}).filter(([, v]) => v !== undefined).map(([key, v]) => [key, String(v)]));
    for (const key of keys()) {
      if (!next.has(key))
        remove(key);
    }
    for (const [key, v] of next)
      write(key, v);
  };

  const view = new Proxy({} as NodeJS.ProcessEnv, {
    get: (_, key) => typeof key === 'string' ? read(key) : undefined,
    set: (_, key, value) => {
      if (typeof key === 'string')
        write(key, String(value));
      return true;
    },
    defineProperty: (_, key, descriptor) => {
      if (typeof key === 'string' && 'value' in descriptor)
        write(key, String(descriptor.value));
      return true;
    },
    deleteProperty: (_, key) => {
      if (typeof key === 'string')
        remove(key);
      return true;
    },
    has: (_, key) => typeof key === 'string' && read(key) !== undefined,
    ownKeys: () => keys(),
    getOwnPropertyDescriptor: (_, key) => {
      const value = typeof key === 'string' ? read(key) : undefined;
      return value === undefined ? undefined : { value, writable: true, enumerable: true, configurable: true };
    },
  });
  Object.defineProperty(process, 'env', { get: () => view, set: replace, configurable: true, enumerable: true });
}
