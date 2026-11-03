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

test('use in test details sets options for that test only', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.test.ts': `
      import { test as base, expect } from '@playwright/test';
      const test = base.extend<{ color: string }>({ color: ['grey', { option: true }] });
      test.use({ color: 'red' });
      test('file option', async ({ color }) => {
        expect(color).toBe('red');
      });
      test('own option', { use: { color: 'blue' }, tag: '@x' }, async ({ color }) => {
        expect(color).toBe('blue');
      });
      test.describe('group', { use: { color: 'green' } }, () => {
        test('group option', async ({ color }) => {
          expect(color).toBe('green');
        });
        test('own option wins', { use: { color: 'pink' } }, async ({ color }) => {
          expect(color).toBe('pink');
        });
      });
      test('back to the file option', async ({ color }) => {
        expect(color).toBe('red');
      });
    `,
  }, { workers: 1 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(5);
});

test('use in test details changes the page of that test', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.test.ts': `
      import { test, expect } from '@playwright/test';
      test('phone', { use: { viewport: { width: 390, height: 844 }, locale: 'de-DE' } }, async ({ page }) => {
        expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
        expect(await page.evaluate(() => navigator.language)).toBe('de-DE');
      });
      test('default', async ({ page }) => {
        expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });
      });
    `,
  }, { workers: 1 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(2);
});

test('worker options cannot be set in test details', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.test.ts': `
      import { test } from '@playwright/test';
      test('firefox', { use: { browserName: 'firefox' } }, async () => {});
    `,
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('Cannot set browserName in the use details of a test, because it forces a new worker.');
});

test('use in test details is typed', async ({ runTSC }) => {
  const result = await runTSC({
    'a.spec.ts': `
      import { test as base } from '@playwright/test';
      const test = base.extend<{ color: string }>({ color: ['grey', { option: true }] });
      test('typed', { use: { color: 'blue', viewport: { width: 1, height: 1 } } }, async () => {});
      // @ts-expect-error
      test('wrong type', { use: { color: 1 } }, async () => {});
      test.describe('group', { use: { color: 'green' } }, () => {});
    `,
  });
  expect(result.exitCode).toBe(0);
});
