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
const otherPlatform = platform === 'darwin' ? 'linux' : 'darwin';

const files = {
  'a.spec.ts': `
    import { test, expect } from '@playwright/test';
    test('a', async () => {
      expect('hello').toMatchSnapshot('used.txt');
    });
  `,
  'b.spec.ts': `
    import { test, expect } from '@playwright/test';
    test('b', async () => {
      expect('world').toMatchSnapshot('b.txt');
    });
    test.skip('skipped', async () => {
      expect('x').toMatchSnapshot('skipped.txt');
    });
  `,
  [`a.spec.ts-snapshots/used-${platform}.txt`]: 'hello',
  [`a.spec.ts-snapshots/stale-${platform}.txt`]: 'old',
  [`a.spec.ts-snapshots/used-${otherPlatform}.txt`]: 'hello',
  [`a.spec.ts-snapshots/shot-chromium-${otherPlatform}.png`]: 'png',
  [`a.spec.ts-snapshots/gone.aria.yml`]: '- heading',
  [`a.spec.ts-snapshots/notes.md`]: 'not a snapshot',
  [`deleted.spec.ts-snapshots/old-${platform}.txt`]: 'old',
  [`b.spec.ts-snapshots/b-${platform}.txt`]: 'world',
  [`b.spec.ts-snapshots/skipped-${platform}.txt`]: 'x',
  [`b.spec.ts-snapshots/stale-${platform}.txt`]: 'old',
  'assets/picture.png': 'not a snapshot',
};

test('--prune-snapshots deletes the snapshots no test used', async ({ runInlineTest }) => {
  const result = await runInlineTest(files, { 'prune-snapshots': true });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(2);
  expect(result.output).toContain('Pruned 3 stale snapshots:');
  const exists = (file: string) => fs.existsSync(test.info().outputPath(file));
  expect(exists(`a.spec.ts-snapshots/used-${platform}.txt`)).toBe(true);
  expect(exists(`a.spec.ts-snapshots/stale-${platform}.txt`)).toBe(false);
  expect(exists('a.spec.ts-snapshots/gone.aria.yml')).toBe(false);
  expect(exists('deleted.spec.ts-snapshots')).toBe(false);
  // Another platform's snapshots and files that are not snapshots stay.
  expect(exists(`a.spec.ts-snapshots/used-${otherPlatform}.txt`)).toBe(true);
  expect(exists(`a.spec.ts-snapshots/shot-chromium-${otherPlatform}.png`)).toBe(true);
  expect(exists('a.spec.ts-snapshots/notes.md')).toBe(true);
  expect(exists('assets/picture.png')).toBe(true);
  // A file with a skipped test keeps all its snapshots.
  expect(exists(`b.spec.ts-snapshots/skipped-${platform}.txt`)).toBe(true);
  expect(exists(`b.spec.ts-snapshots/stale-${platform}.txt`)).toBe(true);
});

test('--prune-snapshots needs a complete run that passes', async ({ runInlineTest }) => {
  const filtered = await runInlineTest(files, { 'prune-snapshots': true, 'grep': 'a' });
  expect(filtered.output).toContain('Snapshots were not pruned: the run selected some of the tests.');

  const failing = await runInlineTest({
    ...files,
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('a', async () => {
        expect(1).toBe(2);
        expect('hello').toMatchSnapshot('used.txt');
      });
    `,
  }, { 'prune-snapshots': true });
  expect(failing.exitCode).toBe(1);
  expect(failing.output).toContain('Snapshots were not pruned: some tests failed.');
  expect(fs.existsSync(test.info().outputPath(`a.spec.ts-snapshots/used-${platform}.txt`))).toBe(true);
  expect(fs.existsSync(test.info().outputPath(`a.spec.ts-snapshots/stale-${platform}.txt`))).toBe(true);
});

test('--prune-snapshots follows a custom template', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `export default { snapshotPathTemplate: '__snapshots__/{testFilePath}/{arg}{ext}' };`,
    'tests/a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('a', async () => {
        expect('hello').toMatchSnapshot('used.txt');
      });
    `,
    '__snapshots__/tests/a.spec.ts/used.txt': 'hello',
    '__snapshots__/tests/a.spec.ts/stale.txt': 'old',
    'tests/a.spec.ts-snapshots/unrelated-linux.txt': 'kept',
  }, { 'prune-snapshots': true });
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain('Pruned 1 stale snapshot:');
  expect(fs.existsSync(test.info().outputPath('__snapshots__/tests/a.spec.ts/used.txt'))).toBe(true);
  expect(fs.existsSync(test.info().outputPath('__snapshots__/tests/a.spec.ts/stale.txt'))).toBe(false);
  expect(fs.existsSync(test.info().outputPath('tests/a.spec.ts-snapshots/unrelated-linux.txt'))).toBe(true);
});

test('--prune-snapshots keeps the screenshots of each project', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `export default { projects: [{ name: 'chromium' }] };`,
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('a', async ({ page }) => {
        await page.setContent('<div style="width: 20px; height: 20px; background: red"></div>');
        await expect(page.locator('div')).toHaveScreenshot('box.png');
      });
    `,
  }, { 'update-snapshots': 'all' });
  expect(result.exitCode).toBe(0);
  const dir = test.info().outputPath('a.spec.ts-snapshots');
  expect(fs.readdirSync(dir)).toEqual([`box-chromium-${platform}.png`]);
  fs.copyFileSync(`${dir}/box-chromium-${platform}.png`, `${dir}/old-chromium-${platform}.png`);
  fs.copyFileSync(`${dir}/box-chromium-${platform}.png`, `${dir}/box-chromium-${otherPlatform}.png`);

  const pruned = await runInlineTest({}, { 'prune-snapshots': true });
  expect(pruned.exitCode).toBe(0);
  expect(pruned.output).toContain(`Pruned 1 stale snapshot:\n  a.spec.ts-snapshots/old-chromium-${platform}.png`);
  expect(fs.readdirSync(dir).sort()).toEqual([`box-chromium-${otherPlatform}.png`, `box-chromium-${platform}.png`].sort());
});
