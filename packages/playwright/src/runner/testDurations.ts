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

// Flashwright, opt-in with FLASHWRIGHT_TEST_ORDER=longest-first: with several workers, a run ends
// when its busiest worker does. Starting the longest test groups first, by how long their tests
// took in the previous run of the same config, keeps a long group from starting last and running
// alone at the end. It is opt-in because it changes which tests share a worker and in what order,
// which breaks suites whose tests depend on what ran before them in the same worker.

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { TestGroup } from './testGroups';
import type * as test from '../common/test';

const durationsDir = path.join(os.tmpdir(), 'flashwright-test-durations');
const maxEntries = 20000;
const maxFiles = 200;

export function testOrderingEnabled() {
  return process.env.FLASHWRIGHT_TEST_ORDER === 'longest-first';
}

function durationsFile(configFile: string | undefined) {
  const key = crypto.createHash('sha1').update(configFile ?? process.cwd()).digest('hex').slice(0, 16);
  return path.join(durationsDir, `${key}.json`);
}

export function loadTestDurations(configFile: string | undefined): Map<string, number> {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(durationsFile(configFile), 'utf8'))));
  } catch {
    return new Map();
  }
}

export function saveTestDurations(configFile: string | undefined, previous: Map<string, number>, tests: test.TestCase[]) {
  const durations = new Map(previous);
  for (const test of tests) {
    const result = test.results[test.results.length - 1];
    if (result && result.status !== 'skipped') {
      // Most recent first, so the oldest entries are the ones dropped.
      durations.delete(test.id);
      durations.set(test.id, result.duration);
    }
  }
  const entries = [...durations].slice(-maxEntries);
  try {
    fs.mkdirSync(durationsDir, { recursive: true });
    const file = durationsFile(configFile);
    // Write a sibling file and rename it, so concurrent runs never read a partial file.
    const temporary = `${file}.${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(entries)));
    fs.renameSync(temporary, file);
    pruneDurationFiles();
  } catch {
  }
}

// Keeps the files of the most recently run configs.
function pruneDurationFiles() {
  const names = fs.readdirSync(durationsDir);
  if (names.length <= maxFiles)
    return;
  const files = names.map(name => path.join(durationsDir, name)).map(file => ({ file, mtime: fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0 }));
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of files.slice(maxFiles))
    fs.rmSync(file, { force: true });
}

// Longest groups first, by the summed durations of their tests. Tests without a duration (new or
// renamed ones) count as the slowest known test. Groups for different kinds of workers keep their
// original relative order, so workers are not restarted more often than before.
export function orderTestGroupsByDuration(testGroups: TestGroup[], durations: Map<string, number>) {
  const known = testGroups.flatMap(group => group.tests).map(test => durations.get(test.id)).filter(duration => duration !== undefined);
  if (!known.length)
    return;
  const unknown = Math.max(...known);
  const estimate = new Map(testGroups.map(group => [group, group.tests.reduce((sum, test) => sum + (durations.get(test.id) ?? unknown), 0)]));
  const workerHashes = [...new Set(testGroups.map(group => group.workerHash))];
  const ordered = workerHashes.flatMap(hash => testGroups.filter(group => group.workerHash === hash).sort((a, b) => estimate.get(b)! - estimate.get(a)!));
  testGroups.splice(0, testGroups.length, ...ordered);
}
