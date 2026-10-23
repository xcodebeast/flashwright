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

// Flashwright: with FLASHWRIGHT_SESSION=1, a background session keeps a runner process ready for
// the next run and hands the browser of one run's workers to the next run's (see session.ts). Each
// run must behave exactly like a run without the session.

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { test, expect } from './playwright-test-fixtures';

import type { AddressInfo } from 'net';

// A session lives in the system temp directory and outlasts the test; give every test its own,
// with a short path (sockets have a length limit), and let the session exit soon after.
let tmpDir: string;
test.beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-session-'));
});
test.afterEach(async () => {
  // The session removes its socket when it exits.
  await expect.poll(() => fs.readdirSync(tmpDir, { recursive: true }).some(file => String(file).endsWith('.sock')), { timeout: 20000 }).toBe(false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
const env = () => ({ TMPDIR: tmpDir, FLASHWRIGHT_SESSION: '1', FLASHWRIGHT_SESSION_TIMEOUT: '3' });

async function startServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>app</title>`);
  });
  await new Promise<void>(f => server.listen(0, '127.0.0.1', f));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

// Prints the browser's process id, checks that nothing is left from an earlier run, and leaves
// something behind for the next one.
const files = (baseURL: string, name: string) => ({
  'playwright.config.js': `module.exports = { workers: 1, use: { baseURL: '${baseURL}' } };`,
  'a.spec.ts': `
    import { test, expect } from '@playwright/test';
    test('${name}', async ({ page, browser, context }) => {
      const cdp = await browser.newBrowserCDPSession();
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
      console.log('%%browser ' + processInfo.find(p => p.type === 'browser').id);
      await page.goto('/');
      await expect(page).toHaveTitle('app');
      expect(await page.evaluate(() => localStorage.getItem('previous'))).toBe(null);
      expect(await context.cookies()).toEqual([]);
      expect(context.pages()).toEqual([page]);
      await page.evaluate(() => localStorage.setItem('previous', 'run'));
      await context.addCookies([{ name: 'previous', value: 'run', url: '${baseURL}' }]);
    });
  `,
});

test('the next run takes over the browser, reset', async ({ runInlineTest }) => {
  const server = await startServer();
  try {
    const browsers: string[] = [];
    for (const name of ['first', 'second', 'third']) {
      const result = await runInlineTest(files(server.url, name), {}, env());
      expect(result.exitCode).toBe(0);
      expect(result.passed).toBe(1);
      expect(result.output).toContain(name);
      browsers.push(...result.outputLines.filter(line => line.startsWith('browser ')));
    }
    expect(browsers).toHaveLength(3);
    // The first run started the session, which took its browser; the others ran in it.
    expect(new Set(browsers).size).toBe(1);
  } finally {
    server.close();
  }
});

test('reports failures and output like a run without the session', async ({ runInlineTest }) => {
  const test = `
    import { test, expect } from '@playwright/test';
    test('passes', async ({ page }) => {
      console.log('%%from the test');
    });
    test('fails', async ({ page }) => {
      await page.setContent('<div>actual</div>');
      await expect(page.locator('div')).toHaveText('expected', { timeout: 1000 });
    });
  `;
  for (let i = 0; i < 2; i++) {
    const result = await runInlineTest({ 'a.spec.ts': test }, { workers: 1 }, env());
    expect(result.exitCode).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.outputLines).toEqual(['from the test']);
    expect(result.output).toContain(`Expected: "expected"`);
    expect(result.output).toContain(`Received: "actual"`);
  }
});

test('picks up changed tests and configs', async ({ runInlineTest }) => {
  for (const value of ['one', 'two']) {
    const result = await runInlineTest({
      'playwright.config.js': `module.exports = { workers: 1, metadata: { value: '${value}' } };`,
      'a.spec.ts': `
        import { test, expect } from '@playwright/test';
        test('test', async ({ page }) => {
          console.log('%%' + test.info().config.metadata.value + ' ${value}');
        });
      `,
    }, {}, env());
    expect(result.exitCode).toBe(0);
    expect(result.outputLines).toEqual([`${value} ${value}`]);
  }
});

test('a run with a different environment runs on its own', async ({ runInlineTest }) => {
  for (const value of ['one', 'two', 'two']) {
    const result = await runInlineTest({
      'a.spec.ts': `
        import { test, expect } from '@playwright/test';
        test('test', async ({ page }) => {
          await page.setContent('<div>hi</div>');
          console.log('%%' + process.env.MY_VALUE);
        });
      `,
    }, { workers: 1 }, { ...env(), MY_VALUE: value });
    expect(result.exitCode).toBe(0);
    expect(result.outputLines).toEqual([value]);
  }
});
