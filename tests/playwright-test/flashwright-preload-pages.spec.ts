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

// Flashwright: the preloadPages option loads the page the next test opens first while the
// previous test runs.

import fs from 'fs';

import { test, expect } from './playwright-test-fixtures';

// The history of what tests opened first is kept in the temporary folder, under the config's path:
// each test starts without one.
function withoutHistory() {
  const tmpdir = test.info().outputPath('tmp');
  fs.mkdirSync(tmpdir, { recursive: true });
  return { TMPDIR: tmpdir };
}

// Serves /app, which stores something in every kind of storage, has a frame and throws while
// loading, /popup and /worker, which open a popup and start a service worker, and any other path
// as a plain page. `loads(path)` tells how many times a path was requested.
const server = `
  import http from 'http';
  const requests = [];
  export const loads = path => requests.filter(url => url === path).length;
  export let origin;
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/app') {
      res.end(\`<iframe src="/frame"></iframe><script>
        localStorage.setItem('loads', String(Number(localStorage.getItem('loads') || 0) + 1));
        sessionStorage.setItem('session', 'set');
        document.cookie = 'visited=1';
        throw new Error('thrown while loading');
      </script>\`);
    } else if (req.url === '/popup') {
      res.end('<script>window.open("/other")</script>');
    } else if (req.url === '/worker') {
      res.end('<script>navigator.serviceWorker.register("/sw.js")</script>');
    } else if (req.url === '/sw.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end('');
    } else {
      res.end('<p>' + req.url + '</p>');
    }
  });
  export const listening = new Promise(f => server.listen(0, () => {
    origin = 'http://127.0.0.1:' + server.address().port;
    f();
  }));
  export const close = () => server.close();
`;

test('should show a preloaded page as the navigation of the next test', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `export default { workers: 1, use: { preloadPages: true } };`,
    'server.ts': server,
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      import { listening, origin, loads, close } from './server';
      test.beforeAll(() => listening);
      test.afterAll(() => close());

      test('first', async ({ page }) => {
        await page.goto(origin + '/app');
        // Long enough for the next test's page to load, short enough for it to be used.
        await page.waitForTimeout(300);
      });

      test('preloaded', async ({ page }) => {
        // The next test's page loaded while the first test ran, but this test sees a blank tab.
        expect(loads('/app')).toBe(2);
        expect(page.url()).toBe('about:blank');
        expect(page.frames()).toHaveLength(1);
        const events = [];
        page.on('framenavigated', frame => events.push('navigated ' + new URL(frame.url()).pathname));
        page.on('load', () => events.push('load'));
        page.on('pageerror', error => events.push('error ' + error.message));
        const gotoTime = Date.now();
        const [response] = await Promise.all([
          page.goto(origin + '/app'),
          page.waitForEvent('load'),
        ]);
        expect(response.request().timing().startTime).toBeLessThan(gotoTime - 50);
        expect(response.status()).toBe(200);
        expect(response.request().isNavigationRequest()).toBe(true);
        expect(page.url()).toBe(origin + '/app');
        expect(page.frames().map(frame => new URL(frame.url()).pathname)).toEqual(['/app', '/frame']);
        expect(events).toContain('navigated /app');
        expect(events).toContain('load');
        expect(events).toContain('error thrown while loading');
        // Like any test's page, a new tab in a context of its own.
        expect(await page.evaluate(() => [localStorage.getItem('loads'), history.length])).toEqual(['1', 2]);
      });

      test('waits for a request along with the goto', async ({ page }) => {
        // Preloaded since the previous test went there, but the request it waits for is the
        // navigation's: the goto navigates.
        const gotoTime = Date.now();
        const [response, request] = await Promise.all([
          page.goto(origin + '/app'),
          page.waitForEvent('requestfinished', request => request.url().endsWith('/app')),
        ]);
        expect(request).toBe(response.request());
        expect(request.timing().startTime).toBeGreaterThan(gotoTime - 50);
      });

      test('goes elsewhere', async ({ page }) => {
        // The preloaded /app stored things for this origin: none of it is left.
        await page.goto(origin + '/other');
        expect(await page.evaluate(() => [localStorage.getItem('loads'), sessionStorage.getItem('session'), document.cookie, history.length])).toEqual([null, null, '', 2]);
      });

      test('calls something first', async ({ page }) => {
        // Preloaded too, since the previous test went there, but this test routes it first.
        await page.route('**/other', route => route.fulfill({ contentType: 'text/html', body: '<p>routed</p>' }));
        await page.goto(origin + '/other');
        await expect(page.locator('p')).toHaveText('routed');
        expect(await page.evaluate(() => [localStorage.getItem('loads'), sessionStorage.getItem('session'), document.cookie, history.length])).toEqual([null, null, '', 2]);
      });
    `,
  }, {}, withoutHistory());
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(5);
});

test('should preload what each test opened first in the previous run', async ({ runInlineTest }) => {
  const files = {
    'playwright.config.ts': `export default { workers: 1, use: { preloadPages: true } };`,
    'server.ts': server,
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      import { listening, origin, loads, close } from './server';
      test.beforeAll(() => listening);
      test.afterAll(() => { console.log('%%loads ' + ['/one', '/two', '/three'].map(loads).join(' ')); close(); });

      for (const path of ['/one', '/two', '/three']) {
        test(path, async ({ page }) => {
          await page.goto(origin + path);
          await expect(page.locator('p')).toHaveText(path);
          await page.waitForTimeout(300);
        });
      }
    `,
  };
  // Without a previous run, each test's page is guessed to be the one the test before it opened.
  const env = withoutHistory();
  const first = await runInlineTest(files, {}, env);
  expect(first.exitCode).toBe(0);
  expect(first.outputLines).toEqual(['loads 2 2 1']);
  // Then each test gets the page it opened last time.
  const second = await runInlineTest(files, {}, env);
  expect(second.exitCode).toBe(0);
  expect(second.outputLines).toEqual(['loads 1 1 1']);
});

test('should not preload a page that opens a popup or starts a service worker', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `export default { workers: 1, use: { preloadPages: true } };`,
    'server.ts': server,
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      import { listening, origin, loads, close } from './server';
      test.beforeAll(() => listening);
      test.afterAll(() => close());

      test('opens a popup', async ({ page }) => {
        await Promise.all([page.waitForEvent('popup'), page.goto(origin + '/popup')]);
        await page.waitForTimeout(300);
      });

      test('opens it again', async ({ page, context }) => {
        // Preloaded, but nothing of it is left: the popup it opened would show before the goto.
        expect(loads('/popup')).toBe(2);
        expect(context.pages()).toEqual([page]);
        const gotoTime = Date.now();
        const [popup, response] = await Promise.all([page.waitForEvent('popup'), page.goto(origin + '/popup')]);
        expect(response.request().timing().startTime).toBeGreaterThan(gotoTime - 50);
        await expect(popup).toHaveURL(origin + '/other');
      });

      test('starts a service worker', async ({ page, context }) => {
        await Promise.all([context.waitForEvent('serviceworker'), page.goto(origin + '/worker')]);
        await page.waitForTimeout(300);
      });

      test('starts it again', async ({ page, context }) => {
        expect(loads('/worker')).toBe(2);
        expect(context.serviceWorkers()).toEqual([]);
        const gotoTime = Date.now();
        const [, response] = await Promise.all([context.waitForEvent('serviceworker'), page.goto(origin + '/worker')]);
        expect(response.request().timing().startTime).toBeGreaterThan(gotoTime - 50);
      });
    `,
  }, {}, withoutHistory());
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(4);
});
