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

import { test, expect } from './playwright-test-fixtures';

test('--watch runs the tests of changed files, with the title filter and projects', async ({ startCLICommand, writeFiles }) => {
  const testProcess = await startCLICommand({
    'playwright.config.ts': `export default { projects: [{ name: 'one' }, { name: 'two' }] };`,
    'a.test.ts': `
      import { test } from '@playwright/test';
      test('wanted', () => {});
      test('other', () => {});
    `,
    'b(1).test.ts': `
      import { test } from '@playwright/test';
      test('wanted', () => {});
    `,
  }, 'test', ['--watch', '--grep', 'wanted', '--project', 'one']);
  await testProcess.waitForOutput('Waiting for file changes.');
  testProcess.clearOutput();

  await writeFiles({
    'b(1).test.ts': `
      import { test, expect } from '@playwright/test';
      console.log('output while loading');
      test('wanted', () => { expect(1).toBe(2); });
    `,
  });
  await testProcess.waitForOutput('Waiting for file changes.');
  // The test file was loaded by a loader started ahead of the run, which prints like any loader.
  expect(testProcess.output).toContain('output while loading');
  expect(testProcess.output).toContain('(files changed)');
  expect(testProcess.output).toContain('[one] › b(1).test.ts:4:11 › wanted');
  expect(testProcess.output).toContain('1 failed');
  expect(testProcess.output).not.toContain('[two]');
  expect(testProcess.output).not.toContain('a.test.ts');

  testProcess.clearOutput();
  await writeFiles({
    'a.test.ts': `
      import { test } from '@playwright/test';
      test('wanted', () => {});
      test('other', () => {});
    `,
  });
  await testProcess.waitForOutput('Waiting for file changes.');
  expect(testProcess.output).toContain('[one] › a.test.ts:3:11 › wanted');
  expect(testProcess.output).toContain('1 passed');
  expect(testProcess.output).not.toContain('other');
  expect(testProcess.output).not.toContain('b(1).test.ts');

  // "r" repeats the last run of changed files.
  testProcess.clearOutput();
  testProcess.write('r');
  await testProcess.waitForOutput('Waiting for file changes.');
  expect(testProcess.output).toContain('(re-running tests)');
  expect(testProcess.output).toContain('[one] › a.test.ts:3:11 › wanted');
  expect(testProcess.output).toContain('1 passed');
});
