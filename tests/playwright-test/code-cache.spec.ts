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


// Flashwright: the V8 code cache of Playwright's bundles (see codeCache.ts) is written at exit by
// the first process of its kind that ran tests, which compiled what the next runs will run.

import fs from 'fs';
import path from 'path';

import { test, expect } from './playwright-test-fixtures';

function cacheFiles(tmpDir: string) {
  const directory = path.join(tmpDir, 'flashwright-code-cache');
  if (!fs.existsSync(directory))
    return [];
  return fs.readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter(file => fs.statSync(path.join(directory, file)).isFile());
}

test('is written by a run that ran tests, not by one that listed them', async ({ runInlineTest }, testInfo) => {
  const tmpDir = testInfo.outputPath('tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const files = {
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('passes', async () => {});
    `,
  };
  const listed = await runInlineTest(files, { list: true }, { TMPDIR: tmpDir });
  expect(listed.exitCode).toBe(0);
  expect(cacheFiles(tmpDir)).toEqual([]);

  const result = await runInlineTest(files, {}, { TMPDIR: tmpDir });
  expect(result.passed).toBe(1);
  const written = cacheFiles(tmpDir);
  expect(written.some(file => file.includes(path.sep + 'runner' + path.sep))).toBe(true);
  expect(written.some(file => file.includes(path.sep + 'worker' + path.sep))).toBe(true);
});
