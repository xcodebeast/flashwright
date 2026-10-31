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

const adoptionSpec = `
  import { test as base, expect } from '@playwright/test';
  const test = base.extend<{}, { startedAhead: any }>({
    startedAhead: [async ({}, use) => use((globalThis as any)[Symbol.for('flashwright.speculativeBrowser')]), { scope: 'worker', auto: true }],
  });
  test('uses a page', async ({ browser, page, startedAhead }, testInfo) => {
    await page.setContent('<button>Click</button>');
    await page.getByRole('button').click();
    console.log('%%' + testInfo.project.name + ' ' + (browser === await startedAhead ? 'adopted' : 'launched'));
  });
`;

test('a worker starts the browser that the tests of its config launched last time', async ({ runInlineTest }) => {
  const files = {
    'playwright.config.ts': `export default { projects: [{ name: 'args', use: { launchOptions: { args: ['--mute-audio'] } } }] };`,
    'a.spec.ts': adoptionSpec,
  };
  // The first run remembers which browser its tests launched.
  const first = await runInlineTest(files, { workers: 1 });
  expect(first.exitCode).toBe(0);
  const second = await runInlineTest(files, { workers: 1 });
  expect(second.exitCode).toBe(0);
  expect(second.outputLines).toEqual(['args adopted']);
});

test('workers start the default browser when the last run launched different ones', async ({ runInlineTest }) => {
  const files = {
    'playwright.config.ts': `export default { fullyParallel: true, projects: [{ name: 'default' }, { name: 'args', use: { launchOptions: { args: ['--mute-audio'] } } }] };`,
    'a.spec.ts': adoptionSpec,
  };
  const first = await runInlineTest(files, { workers: 2 });
  expect(first.exitCode).toBe(0);
  const second = await runInlineTest(files, { workers: 2 });
  expect(second.exitCode).toBe(0);
  expect(second.outputLines.sort()).toEqual(['args launched', 'default adopted']);
});

test('a browser started ahead of time saves downloads where the launch options ask', async ({ runInlineTest, server }, testInfo) => {
  server.setRoute('/download', (req, res) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment');
    res.end('Hello world');
  });
  const downloadsPath = testInfo.outputPath('downloads');
  const files = {
    'playwright.config.ts': `export default { projects: [{ name: 'downloads', use: { launchOptions: { downloadsPath: ${JSON.stringify(downloadsPath)} } } }] };`,
    'a.spec.ts': adoptionSpec.replace(`await page.getByRole('button').click();`, `
      await page.setContent('<a href="${server.PREFIX}/download">download</a>');
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('a')]);
      expect(await download.path()).toContain(${JSON.stringify(downloadsPath)});
    `),
  };
  expect((await runInlineTest(files, { workers: 1 })).exitCode).toBe(0);
  const second = await runInlineTest(files, { workers: 1 });
  expect(second.exitCode).toBe(0);
  expect(second.outputLines).toEqual(['downloads adopted']);
});

test('a browser started ahead of time is not used when the config changes its environment', async ({ runInlineTest }) => {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone === 'Asia/Tokyo' ? 'America/Lima' : 'Asia/Tokyo';
  const result = await runInlineTest({
    'playwright.config.ts': `
      process.env.TZ = ${JSON.stringify(timeZone)};
      export default {};
    `,
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('sees the time zone', async ({ page }) => {
        expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(${JSON.stringify(timeZone)});
      });
    `,
  }, { workers: 1 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(1);
});
