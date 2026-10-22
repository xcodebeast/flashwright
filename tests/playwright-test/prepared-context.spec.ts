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

// Flashwright: a spare worker, kept ready to replace a failed one, prepares the browser context its
// first test is likely to ask for, from the options the same config used in its previous run. The
// tests that run in replacement workers must see exactly the context they ask for.

import fs from 'fs';
import http from 'http';

import { test, expect } from './playwright-test-fixtures';

import type { AddressInfo } from 'net';

// Hints are kept in the system temp directory; give every test its own.
test.beforeEach(async ({}, testInfo) => {
  fs.mkdirSync(testInfo.outputPath('tmp'), { recursive: true });
});
const env = () => ({ TMPDIR: test.info().outputPath('tmp') });

async function startServer(name: string) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>${name}</title>`);
  });
  await new Promise<void>(f => server.listen(0, '127.0.0.1', f));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

// Every third test fails, so the following ones run in replacement workers. Each test checks the
// options it asked for and that nothing is left from an earlier test.
const suite = (expectedTitle: string, expectedLanguage: string) => `
  import { test, expect } from '@playwright/test';
  for (let i = 0; i < 9; i++) {
    test('test ' + i, async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveTitle('${expectedTitle}');
      expect(await page.evaluate(() => navigator.language)).toBe('${expectedLanguage}');
      expect(await page.evaluate(() => localStorage.getItem('previous'))).toBe(null);
      expect(page.viewportSize()).toEqual({ width: 700, height: 500 });
      await page.evaluate(() => localStorage.setItem('previous', 'test'));
      // Waits long enough for the spare to prepare its context.
      await page.waitForTimeout(300);
      expect(i % 3).not.toBe(2);
    });
  }
`;

const config = (baseURL: string, locale: string) => `
  module.exports = { workers: 1, use: { baseURL: '${baseURL}', locale: '${locale}', viewport: { width: 700, height: 500 } } };
`;

test('replacement workers get the context their tests ask for', async ({ runInlineTest }) => {
  const first = await startServer('first');
  const second = await startServer('second');
  try {
    const run1 = await runInlineTest({
      'playwright.config.js': config(first.url, 'de-DE'),
      'a.spec.ts': suite('first', 'de-DE'),
    }, {}, env());
    expect(run1.passed).toBe(6);
    expect(run1.failed).toBe(3);

    // A different baseURL can reuse the prepared context.
    const run2 = await runInlineTest({
      'playwright.config.js': config(second.url, 'de-DE'),
      'a.spec.ts': suite('second', 'de-DE'),
    }, {}, env());
    expect(run2.passed).toBe(6);
    expect(run2.failed).toBe(3);

    // A different locale cannot.
    const run3 = await runInlineTest({
      'playwright.config.js': config(second.url, 'fr-FR'),
      'a.spec.ts': suite('second', 'fr-FR'),
    }, {}, env());
    expect(run3.passed).toBe(6);
    expect(run3.failed).toBe(3);
  } finally {
    first.close();
    second.close();
  }
});

test('prepared contexts take the storage state of the tests', async ({ runInlineTest }) => {
  const server = await startServer('app');
  const files = {
    'playwright.config.js': `
      module.exports = {
        workers: 2,
        use: { baseURL: '${server.url}' },
        projects: [
          { name: 'setup', testMatch: /.*\\.setup\\.ts/ },
          { name: 'app', testMatch: /.*\\.spec\\.ts/, dependencies: ['setup'], use: { storageState: 'state.json' } },
        ],
      };
    `,
    'state.setup.ts': `
      import { test } from '@playwright/test';
      test('setup', async ({ page, context }) => {
        await page.goto('/');
        await page.evaluate(() => localStorage.setItem('user', 'ada'));
        await context.addCookies([{ name: 'session', value: 'ada', url: '${server.url}' }]);
        await context.storageState({ path: 'state.json' });
      });
    `,
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      for (let i = 0; i < 6; i++) {
        test('test ' + i, async ({ page, context }) => {
          await page.goto('/');
          expect(await page.evaluate(() => ({ ...localStorage }))).toEqual({ user: 'ada' });
          expect((await context.cookies()).map(c => c.name + '=' + c.value)).toEqual(['session=ada']);
          await page.evaluate(() => localStorage.setItem('previous', 'test'));
          await context.addCookies([{ name: 'previous', value: 'test', url: page.url() }]);
          await page.waitForTimeout(300);
          expect(i % 3).not.toBe(2);
        });
      }
    `,
  };
  try {
    for (let run = 0; run < 2; run++) {
      const result = await runInlineTest(files, {}, env());
      expect(result.passed).toBe(5);
      expect(result.failed).toBe(2);
    }
  } finally {
    server.close();
  }
});
