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

// Flashwright: the blockResources context option.

import { browserTest as it, expect } from '../config/browserTest';
import type { TestServer } from '../config/testserver';

function servePage(server: TestServer) {
  const served: string[] = [];
  const serve = (path: string, contentType: string, body: string) => server.setRoute(path, (req, res) => {
    served.push(path);
    res.setHeader('Content-Type', contentType);
    res.end(body);
  });
  serve('/page.html', 'text/html', `
    <link rel="stylesheet" href="/style.css">
    <img src="/image.svg">
    <script src="/script.js"></script>
  `);
  serve('/style.css', 'text/css', 'body { background-color: pink; }');
  serve('/image.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
  serve('/script.js', 'text/javascript', 'window.scriptRan = true;');
  return served;
}

it('should fail blocked resource types and load the rest', async ({ browser, server, browserName }) => {
  const served = servePage(server);
  const context = await browser.newContext({ blockResources: ['image', 'stylesheet'] });
  const page = await context.newPage();
  const failed: string[] = [];
  page.on('requestfailed', request => failed.push(request.resourceType()));
  const failure = page.waitForEvent('requestfailed').then(request => request.failure()!.errorText);
  await page.goto(server.PREFIX + '/page.html');
  expect(await page.evaluate(() => (window as any).scriptRan)).toBe(true);
  expect(await page.$eval('img', img => img.naturalWidth)).toBe(0);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  // Firefox requests a stylesheet again after its speculative load fails.
  expect([...new Set(failed)].sort()).toEqual(['image', 'stylesheet']);
  if (browserName === 'chromium')
    expect(await failure).toBe('net::ERR_BLOCKED_BY_CLIENT.Inspector');
  expect(served.sort()).toEqual(['/page.html', '/script.js']);
  await context.close();
});

it('should block before routes see the request', async ({ browser, server }) => {
  const served = servePage(server);
  const context = await browser.newContext({ blockResources: ['image'] });
  const page = await context.newPage();
  const routed: string[] = [];
  await page.route('**/*', route => {
    routed.push(new URL(route.request().url()).pathname);
    return route.continue();
  });
  await page.goto(server.PREFIX + '/page.html');
  expect(await page.$eval('img', img => img.naturalWidth)).toBe(0);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(255, 192, 203)');
  expect([...new Set(routed)].sort()).toEqual(['/page.html', '/script.js', '/style.css']);
  expect([...new Set(served)].sort()).toEqual(['/page.html', '/script.js', '/style.css']);
  await context.close();
});

it('should keep blocking after routes are removed', async ({ browser, server }) => {
  const served = servePage(server);
  const context = await browser.newContext({ blockResources: ['script'] });
  const page = await context.newPage();
  await page.route('**/*', route => route.continue());
  await page.goto(server.PREFIX + '/page.html');
  expect(await page.evaluate(() => (window as any).scriptRan)).toBe(undefined);
  await page.unrouteAll();
  await page.reload();
  expect(await page.evaluate(() => (window as any).scriptRan)).toBe(undefined);
  expect(await page.$eval('img', img => img.naturalWidth)).toBe(10);
  expect(served.filter(path => path === '/script.js')).toEqual([]);
  await context.close();
});

it('should block requests of new pages and popups', async ({ browser, server }) => {
  const served = servePage(server);
  const context = await browser.newContext({ blockResources: ['image'] });
  const page = await context.newPage();
  await page.goto(server.EMPTY_PAGE);
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.evaluate(url => window.open(url), server.PREFIX + '/page.html'),
  ]);
  await popup.waitForLoadState();
  expect(await popup.$eval('img', img => img.naturalWidth)).toBe(0);
  expect(served).not.toContain('/image.svg');
  await context.close();
});
