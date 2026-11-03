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

import { escapeRegExp } from '@isomorphic/stringUtils';
import { sanitizeForFilePath } from '@utils/fileUtils';

import type { FullProjectInternal } from '../common/config';
import type { Suite, TestCase } from '../common/test';
import type { TestRun } from './tasks';

// Flashwright: `playwright test --prune-snapshots` deletes the snapshot files that no test used.
// A file counts as a snapshot when it matches a project's snapshot path template, with this
// machine's platform and the project's name filled in, so other platforms' snapshots never count.
// It only prunes after a complete run: every project and test, no filter, nothing failed. The
// snapshots of a test file with a skipped test are kept, since that test did not say which it uses.

type Pattern = { regex: RegExp, root: string };

export function pruneSnapshots(testRun: TestRun): void {
  const reason = whyNotComplete(testRun);
  if (reason) {
    write(`\nSnapshots were not pruned: ${reason}. Prune after a complete run of every test that passes.\n`);
    return;
  }

  const used = new Set([...testRun.usedSnapshotPaths].map(file => path.normalize(file)));
  const candidates: Pattern[] = [];
  const kept: Pattern[] = [];
  // In any project: the snapshots of the others may be named after the project, or not.
  const filesWithSkippedTests = new Set(testRun.rootSuite!.allTests().filter(test => test.outcome() === 'skipped').map(test => test.location.file));
  for (const project of testRun.filteredProjects) {
    const files = testRun.projectFiles.get(project) ?? [];
    for (const { template, ext } of templates(project)) {
      candidates.push(render(project, template, ext, undefined));
      for (const file of files) {
        if (filesWithSkippedTests.has(file))
          kept.push(render(project, template, ext, file));
      }
    }
  }

  const stale: string[] = [];
  const roots = new Set(candidates.map(c => c.root));
  for (const root of roots) {
    for (const file of listFiles(root)) {
      if (used.has(file) || !candidates.some(c => c.regex.test(file)) || kept.some(k => k.regex.test(file)))
        continue;
      stale.push(file);
    }
  }

  if (!stale.length) {
    write(`\nNo stale snapshots.\n`);
    return;
  }
  stale.sort();
  for (const file of stale)
    fs.rmSync(file, { force: true });
  for (const dir of new Set(stale.map(file => path.dirname(file))))
    removeEmptyDirs(dir, roots);
  write(`\nPruned ${stale.length} stale snapshot${stale.length === 1 ? '' : 's'}:\n${stale.map(file => '  ' + path.relative(process.cwd(), file)).join('\n')}\n`);
}

function whyNotComplete(testRun: TestRun): string | undefined {
  const options = testRun.options;
  const config = testRun.config;
  if (options.locations?.length || options.grep || options.grepInvert || options.testList || options.testListInvert || options.onlyChanged || options.lastFailedTestIds)
    return 'the run selected some of the tests';
  if (options.projectFilter?.length)
    return 'the run selected some of the projects';
  if (config.config.shard)
    return 'the run is one shard';
  if (!testRun.rootSuite)
    return 'no tests were loaded';
  const tests = testRun.rootSuite.allTests();
  if (tests.some(test => hasOnly(test)))
    return 'a test or group is marked .only';
  if (testRun.hasWorkerErrors || tests.some(test => test.outcome() === 'unexpected' || test.outcome() === 'flaky'))
    return 'some tests failed';
  if (tests.some(test => test.results.some(result => result.status === 'interrupted') || (!test.results.length && test.expectedStatus !== 'skipped')))
    return 'some tests did not run';
  return undefined;
}

function hasOnly(test: TestCase): boolean {
  if (test._only)
    return true;
  for (let suite: Suite | undefined = test.parent; suite; suite = suite.parent) {
    if (suite._only)
      return true;
  }
  return false;
}

function templates(project: FullProjectInternal): { template: string, ext: string }[] {
  // The same defaults as TestInfoImpl._resolveSnapshotPaths.
  const legacy = '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}';
  const aria = '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{ext}';
  const expectConfig = project.expect as any;
  return [
    { template: project.snapshotPathTemplate || legacy, ext: kAnyExtension },
    { template: expectConfig?.toHaveScreenshot?.pathTemplate || project.snapshotPathTemplate || legacy, ext: kAnyExtension },
    // Aria snapshots have no platform in their default path: only their extensions count, so that
    // another platform's screenshot next to them is never taken for one.
    { template: expectConfig?.toMatchAriaSnapshot?.pathTemplate || project.snapshotPathTemplate || aria, ext: '(?:\\.aria\\.yml|\\.yml)' },
  ];
}

const kAnyExtension = '(?:\\.[^/\\\\]+)?';

// Turns a template into a regular expression for absolute paths. With a test file, the file's
// parts are filled in; without one, they match any file.
function render(project: FullProjectInternal, template: string, ext: string, testFile: string | undefined): Pattern {
  const placeholders = new Map<string, string>();
  const placeholder = (name: string, regex: string) => {
    const key = `\u0000${name}\u0000`;
    placeholders.set(key, regex);
    return key;
  };
  const any = placeholder('any', '.+');
  const anyDir = placeholder('dir', '.*');
  const extension = placeholder('ext', ext);
  const relative = testFile ? path.relative(project.project.testDir, testFile) : undefined;
  const parsed = relative !== undefined ? path.parse(relative) : undefined;
  const projectName = sanitizeForFilePath(project.project.name);

  const rendered = template
      .replace(/\{(.)?testDir\}/g, '$1' + project.project.testDir)
      .replace(/\{(.)?snapshotDir\}/g, '$1' + project.project.snapshotDir)
      .replace(/\{(.)?snapshotSuffix\}/g, '$1' + process.platform)
      .replace(/\{(.)?testFileDir\}/g, '$1' + (parsed ? parsed.dir : anyDir))
      .replace(/\{(.)?platform\}/g, '$1' + process.platform)
      .replace(/\{(.)?projectName\}/g, projectName ? '$1' + projectName : '')
      .replace(/\{(.)?testName\}/g, '$1' + any)
      .replace(/\{(.)?testFileBaseName\}/g, '$1' + (parsed ? parsed.name : any))
      .replace(/\{(.)?testFileName\}/g, '$1' + (parsed ? parsed.base : any))
      .replace(/\{(.)?testFilePath\}/g, '$1' + (relative ?? any))
      .replace(/\{(.)?arg\}/g, '$1' + any)
      .replace(/\{(.)?ext\}/g, extension);
  const absolute = path.normalize(path.resolve(project.fullConfig.configDir, rendered));

  // Files are looked for under the part before the first placeholder.
  const firstPlaceholder = absolute.indexOf('\u0000');
  const root = firstPlaceholder === -1 ? path.dirname(absolute) : path.dirname(absolute.slice(0, firstPlaceholder) + 'x');

  let source = escapeRegExp(absolute);
  for (const [key, regex] of placeholders) {
    // An empty directory part takes its separator with it, as path.normalize() does.
    if (key.includes('dir'))
      source = source.split(escapeRegExp(path.sep) + key).join(`(?:${escapeRegExp(path.sep)}.+)?`);
    source = source.split(key).join(regex);
  }
  return { regex: new RegExp(`^${source}$`), root };
}

function listFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.'))
        continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory())
        visit(file);
      else if (entry.isFile())
        result.push(file);
    }
  };
  visit(root);
  return result;
}

function removeEmptyDirs(dir: string, roots: Set<string>) {
  for (let current = dir; !roots.has(current) && current !== path.dirname(current); current = path.dirname(current)) {
    try {
      fs.rmdirSync(current);
    } catch {
      return;
    }
  }
}

function write(text: string) {
  process.stdout.write(text);
}
