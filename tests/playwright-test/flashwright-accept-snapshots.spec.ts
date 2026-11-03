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

import fs from 'fs';

import { test, expect } from './playwright-test-fixtures';

const platform = process.platform;

test('accept-snapshots makes the last run\'s actual snapshots the expected ones', async ({ runInlineTest, runCLICommand }) => {
  const files = {
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('changed', async () => {
        expect('new text').toMatchSnapshot('changed.txt');
      });
      test('missing', async () => {
        expect('first').toMatchSnapshot('missing.txt');
      });
      test('same', async () => {
        expect('same').toMatchSnapshot('same.txt');
      });
    `,
    [`a.spec.ts-snapshots/changed-${platform}.txt`]: 'old text',
    [`a.spec.ts-snapshots/same-${platform}.txt`]: 'same',
  };
  const failing = await runInlineTest(files, { 'update-snapshots': 'none' });
  expect(failing.exitCode).toBe(1);
  expect(failing.failed).toBe(2);
  expect(failing.output).toContain('2 snapshots did not match. To accept what this run produced: npx playwright accept-snapshots');

  const accept = await runCLICommand({}, 'accept-snapshots');
  expect(accept.exitCode).toBe(0);
  expect(accept.stdout).toContain(`Accepted 2 snapshots:\n  a.spec.ts-snapshots/changed-${platform}.txt\n  a.spec.ts-snapshots/missing-${platform}.txt`);
  expect(fs.readFileSync(test.info().outputPath(`a.spec.ts-snapshots/changed-${platform}.txt`), 'utf8')).toBe('new text');
  expect(fs.readFileSync(test.info().outputPath(`a.spec.ts-snapshots/missing-${platform}.txt`), 'utf8')).toBe('first');

  const again = await runCLICommand({}, 'accept-snapshots');
  expect(again.stdout).toContain('No snapshots to accept');

  const passing = await runInlineTest({}, { 'update-snapshots': 'none' });
  expect(passing.exitCode).toBe(0);
  expect(passing.passed).toBe(3);
  expect(passing.output).not.toContain('did not match');
});

test('accept-snapshots takes a screenshot that changed', async ({ runInlineTest, runCLICommand }) => {
  const page = (color: string) => ({
    'playwright.config.ts': `export default { projects: [{ name: 'chromium' }] };`,
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('box', async ({ page }) => {
        await page.setContent('<div style="width: 20px; height: 20px; background: ${color}"></div>');
        await expect(page.locator('div')).toHaveScreenshot('box.png');
      });
    `,
  });
  expect((await runInlineTest(page('red'), { 'update-snapshots': 'all' })).exitCode).toBe(0);
  const snapshot = test.info().outputPath(`a.spec.ts-snapshots/box-chromium-${platform}.png`);
  const red = fs.readFileSync(snapshot);

  const changed = await runInlineTest(page('blue'));
  expect(changed.exitCode).toBe(1);
  expect(changed.output).toContain('1 snapshot did not match.');

  const accept = await runCLICommand({}, 'accept-snapshots');
  expect(accept.exitCode).toBe(0);
  expect(accept.stdout).toContain(`Accepted 1 snapshot:\n  a.spec.ts-snapshots/box-chromium-${platform}.png`);
  expect(fs.readFileSync(snapshot).equals(red)).toBe(false);
  expect((await runInlineTest(page('blue'))).exitCode).toBe(0);
});

test('a retry that matches leaves nothing to accept', async ({ runInlineTest, runCLICommand }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('flaky', async ({}, testInfo) => {
        expect(testInfo.retry ? 'good' : 'bad').toMatchSnapshot('value.txt');
      });
    `,
    [`a.spec.ts-snapshots/value-${platform}.txt`]: 'good',
  }, { retries: 1 });
  expect(result.flaky).toBe(1);
  expect(result.output).not.toContain('did not match');
  const accept = await runCLICommand({}, 'accept-snapshots');
  expect(accept.stdout).toContain('No snapshots to accept');
});
