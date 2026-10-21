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

// Flashwright recycles browser contexts between tests. Each "leaves" test changes state a test
// can change; the following "sees" test must observe exactly what a brand-new context offers.
// These pass unchanged with FLASHWRIGHT_ISOLATION=strict, which uses a new context per test.

import { test as it, expect } from './pageTest';

it.describe.configure({ mode: 'default' });

it('leaves storage, permissions and context settings behind', async ({ page, context, server }) => {
  await page.goto(server.PREFIX + '/serviceworkers/empty/sw.html');
  await page.evaluate(() => (window as any).registrationPromise);
  await page.evaluate(async () => {
    document.cookie = 'fromPage=1; max-age=3600';
    localStorage.setItem('local', '1');
    sessionStorage.setItem('session', '1');
    window.name = 'previous-test';
    history.pushState({}, '', '#one');
    history.pushState({}, '', '#two');
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('previous-db');
      request.onupgradeneeded = () => request.result.createObjectStore('store');
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    const cache = await caches.open('previous-cache');
    await cache.put('/cached', new Response('cached'));
  });
  await context.addCookies([{ name: 'fromContext', value: '1', url: server.EMPTY_PAGE }]);
  await context.grantPermissions(['geolocation'], { origin: server.PREFIX });
  await context.setGeolocation({ latitude: 10, longitude: 10 });
  await context.setExtraHTTPHeaders({ 'x-previous-test': '1' });
  await context.addInitScript(() => (window as any).previousInitScript = true);
  await context.exposeFunction('previousBinding', () => 1);
  await context.route('**/route-from-previous-test', route => route.fulfill({ body: 'routed' }));
  await context.newPage();
  expect(await page.evaluate(() => localStorage.getItem('local'))).toBe('1');
});

it('sees a fresh context', async ({ page, context, server }) => {
  expect(context.pages()).toEqual([page]);
  expect(page.url()).toBe('about:blank');
  expect(await context.cookies()).toEqual([]);
  const [request] = await Promise.all([
    server.waitForRequest('/empty.html'),
    page.goto(server.EMPTY_PAGE),
  ]);
  expect(request.headers['x-previous-test']).toBe(undefined);
  expect(request.headers.cookie).toBe(undefined);
  expect(await page.evaluate(async () => ({
    cookie: document.cookie,
    local: localStorage.length,
    session: sessionStorage.length,
    name: window.name,
    historyLength: history.length,
    databases: (await indexedDB.databases()).map(db => db.name),
    caches: await caches.keys(),
    registrations: (await navigator.serviceWorker.getRegistrations()).length,
    geolocation: (await navigator.permissions.query({ name: 'geolocation' })).state,
    initScript: (window as any).previousInitScript,
    binding: typeof (window as any).previousBinding,
  }))).toEqual({
    cookie: '',
    local: 0,
    session: 0,
    name: '',
    historyLength: 2,
    databases: [],
    caches: [],
    registrations: 0,
    geolocation: 'prompt',
    initScript: undefined,
    binding: 'undefined',
  });
  server.setRoute('/route-from-previous-test', (req, res) => res.end('from server'));
  expect(await page.evaluate(() => fetch('/route-from-previous-test').then(r => r.text()))).toBe('from server');
});

it('leaves the offline flag on', async ({ context }) => {
  await context.setOffline(true);
});

it('is online again', async ({ page, server }) => {
  await page.goto(server.EMPTY_PAGE);
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
});

it('leaves its renderer stuck in a script', async ({ page }) => {
  await page.setContent(`<script>setTimeout(() => { while (true) {} }, 0)</script>`);
});

it('gets a working page after a stuck renderer', async ({ page }) => {
  await page.setContent('<div>ok</div>');
  await expect(page.locator('div')).toHaveText('ok');
});

it('leaves an alert open', async ({ page }) => {
  page.on('dialog', () => {});
  await page.setContent('<div>alert</div>');
  await page.evaluate(() => setTimeout(() => alert('left open'), 0));
  await page.waitForEvent('dialog');
});

it('gets a working page after an open alert', async ({ page }) => {
  await page.setContent('<div>ok</div>');
  await expect(page.locator('div')).toHaveText('ok');
});

it('leaves a beforeunload handler', async ({ page }) => {
  await page.setContent('<div>beforeunload</div>');
  await page.evaluate(() => window.addEventListener('beforeunload', event => event.preventDefault()));
  await page.click('div');
});

it('gets a working page after beforeunload', async ({ page }) => {
  await page.setContent('<div>ok</div>');
  await expect(page.locator('div')).toHaveText('ok');
});
