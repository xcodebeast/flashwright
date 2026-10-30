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

test('a worker whose tests use no browser closes the one it started ahead of time', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('uses no browser', async ({ request }, testInfo) => {
        expect((globalThis as any)[Symbol.for('flashwright.speculativeBrowser')]).toBe(undefined);
        console.log('%%worker ' + testInfo.workerIndex);
      });
    `,
    'b.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('uses a page', async ({ page }, testInfo) => {
        await page.setContent('<button>Click</button>');
        await page.getByRole('button').click();
        console.log('%%worker ' + testInfo.workerIndex);
      });
    `,
  }, { workers: 1, reporter: 'list' });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(2);
  // Both files ran in the same worker: the second one launched a browser of its own.
  expect(result.outputLines).toEqual(['worker 0', 'worker 0']);
});

test('a worker keeps the browser it started ahead of time for a later test of its file', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('uses no browser', async ({}) => {
        expect((globalThis as any)[Symbol.for('flashwright.speculativeBrowser')]).not.toBe(undefined);
      });
      test('uses a page', async ({ page }) => {
        await page.setContent('<button>Click</button>');
        await page.getByRole('button').click();
      });
    `,
  }, { workers: 1 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(2);
});
