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

// Flashwright: with FLASHWRIGHT_TEST_ORDER=longest-first and several workers, test groups start
// longest first, by the durations of the previous run of the same config.

import fs from 'fs';

import { test, expect } from './playwright-test-fixtures';

// Durations are kept in the system temp directory; give every test its own.
test.beforeEach(async ({}, testInfo) => {
  fs.mkdirSync(testInfo.outputPath('tmp'), { recursive: true });
});
const env = () => ({ TMPDIR: test.info().outputPath('tmp') });
const ordered = () => ({ ...env(), FLASHWRIGHT_TEST_ORDER: 'longest-first' });

// With two workers, the first two queued groups start together and the third starts when one of
// them ends, so the order of the begin lines shows the order of the queue.
const testFile = (name: string, duration: number) => `
  import { test } from '@playwright/test';
  test('${name}', async () => {
    console.log('\\n%%${name}');
    await new Promise(f => setTimeout(f, ${duration}));
  });
`;
const files = {
  'a.spec.ts': testFile('a', 600),
  'b.spec.ts': testFile('b', 600),
  'c.spec.ts': testFile('c', 1500),
};

test('starts the longest test groups first once their durations are known', async ({ runInlineTest }) => {
  const first = await runInlineTest(files, { workers: 2 }, ordered());
  expect(first.passed).toBe(3);
  expect(first.outputLines.indexOf('c')).toBe(2);

  const second = await runInlineTest(files, { workers: 2 }, ordered());
  expect(second.passed).toBe(3);
  expect(second.outputLines.indexOf('c')).toBeLessThan(2);
});

test('keeps the file order with one worker', async ({ runInlineTest }) => {
  await runInlineTest(files, { workers: 2 }, ordered());
  const result = await runInlineTest(files, { workers: 1 }, ordered());
  expect(result.outputLines).toEqual(['a', 'b', 'c']);
});

test('keeps the file order unless enabled', async ({ runInlineTest }) => {
  await runInlineTest(files, { workers: 2 }, ordered());
  const result = await runInlineTest(files, { workers: 2 }, env());
  expect(result.outputLines.indexOf('c')).toBe(2);
});
