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

/* eslint-disable no-restricted-properties */

import fs from 'fs';
import path from 'path';

import { getPackageManagerExecCommand } from '@utils/env';

import { configLoader } from '../common';
import { filterProjects } from './projectUtils';

import type { TestRun } from './tasks';

// Flashwright: `playwright accept-snapshots` makes what the last run produced the expected
// snapshots, without running the tests again. A run lists the snapshots that did not match, from
// each test's last attempt, next to .last-run.json; paths are relative, the actual files to the
// output folder and the snapshots to the config's folder, so that a test-results folder copied
// from CI can be accepted too.

type Entry = { expected: string, actual: string };
type SnapshotsFile = { version: 1, snapshots: Entry[] };

const kFileName = '.last-run-snapshots.json';

export async function recordSnapshotsToAccept(testRun: TestRun) {
  const project = testRun.filteredProjects[0];
  if (!project)
    return;
  const outputDir = project.project.outputDir;
  const file = path.join(outputDir, kFileName);
  const byExpected = new Map<string, Entry>();
  for (const entries of testRun.snapshotsToAccept.values()) {
    for (const entry of entries)
      byExpected.set(entry.expected, entry);
  }
  if (!byExpected.size) {
    await fs.promises.rm(file, { force: true });
    return;
  }
  const configDir = testRun.config.configDir;
  const snapshots = [...byExpected.values()].map(entry => ({
    expected: toPosix(path.relative(configDir, entry.expected)),
    actual: toPosix(path.relative(outputDir, entry.actual)),
  }));
  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify({ version: 1, snapshots } satisfies SnapshotsFile, undefined, 2));
  const count = snapshots.length;
  process.stdout.write(`\n  ${count} snapshot${count === 1 ? '' : 's'} did not match. To accept what this run produced: ${getPackageManagerExecCommand()} playwright accept-snapshots\n`);
}

export async function runAcceptSnapshots(options: { config?: string }): Promise<number> {
  const config = await configLoader.loadConfigFromFile(options.config);
  const project = filterProjects(config.projects)[0];
  if (!project) {
    process.stdout.write('No project in the config.\n');
    return 1;
  }
  const outputDir = project.project.outputDir;
  const file = path.join(outputDir, kFileName);
  let snapshots: Entry[];
  try {
    snapshots = (JSON.parse(await fs.promises.readFile(file, 'utf8')) as SnapshotsFile).snapshots;
  } catch {
    process.stdout.write(`No snapshots to accept: the last run's snapshots matched, or ${path.relative(process.cwd(), outputDir) || outputDir} has no run.\n`);
    return 0;
  }

  const accepted: string[] = [];
  const missing: string[] = [];
  for (const entry of snapshots) {
    const actual = path.resolve(outputDir, entry.actual);
    const expected = path.resolve(config.configDir, entry.expected);
    if (!fs.existsSync(actual)) {
      missing.push(path.relative(process.cwd(), actual));
      continue;
    }
    await fs.promises.mkdir(path.dirname(expected), { recursive: true });
    await fs.promises.copyFile(actual, expected);
    accepted.push(path.relative(process.cwd(), expected));
  }
  if (accepted.length)
    process.stdout.write(`Accepted ${accepted.length} snapshot${accepted.length === 1 ? '' : 's'}:\n${accepted.map(file => '  ' + file).join('\n')}\n`);
  if (missing.length) {
    process.stdout.write(`${missing.length} actual file${missing.length === 1 ? ' is' : 's are'} missing:\n${missing.map(file => '  ' + file).join('\n')}\n`);
    return 1;
  }
  await fs.promises.rm(file, { force: true });
  return 0;
}

function toPosix(file: string): string {
  return file.split(path.sep).join('/');
}
