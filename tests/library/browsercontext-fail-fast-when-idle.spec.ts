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

// Flashwright: the failFastWhenIdle context option.

import { browserTest as base, expect } from '../config/browserTest';

import type { Page } from 'playwright-core';

const it = base.extend<{ idlePage: Page }>({
  idlePage: async ({ browser, server }, use) => {
    const context = await browser.newContext({ failFastWhenIdle: true });
    const page = await context.newPage();
    await page.goto(server.EMPTY_PAGE);
    await use(page);
    await context.close();
  },
});

async function expectToFailWithin(assertion: Promise<unknown>, maxMs: number) {
  const start = Date.now();
  const error = await assertion.catch(e => e);
  expect(error).toBeInstanceOf(Error);
  expect(Date.now() - start).toBeLessThan(maxMs);
  return error as Error;
}

it('should fail early when the page cannot change', async ({ idlePage }) => {
  const error = await expectToFailWithin(expect(idlePage.locator('#missing')).toBeVisible({ timeout: 5000 }), 1500);
  expect(error.message).toContain('failing early (failFastWhenIdle)');
});

it('should fail early for a negated assertion', async ({ idlePage }) => {
  await idlePage.setContent('<div id=here>here</div>');
  await expectToFailWithin(expect(idlePage.locator('#here')).not.toBeVisible({ timeout: 5000 }), 1500);
});

it('should wait for a timer that changes the page', async ({ idlePage }) => {
  await idlePage.evaluate(() => setTimeout(() => document.body.innerHTML = '<div id=late>late</div>', 600));
  await expect(idlePage.locator('#late')).toBeVisible({ timeout: 5000 });
});

it('should wait for an interval that is due before the timeout', async ({ idlePage }) => {
  await idlePage.evaluate(() => {
    let ticks = 0;
    const id = setInterval(() => {
      if (++ticks === 4) {
        clearInterval(id);
        document.body.innerHTML = '<div id=late>late</div>';
      }
    }, 200);
  });
  await expect(idlePage.locator('#late')).toBeVisible({ timeout: 5000 });
});

it('should not wait for a timer due after the timeout', async ({ idlePage }) => {
  await idlePage.evaluate(() => setTimeout(() => document.body.innerHTML = '<div id=late>late</div>', 60000));
  await expectToFailWithin(expect(idlePage.locator('#late')).toBeVisible({ timeout: 3000 }), 1500);
});

it('should wait for a request in flight', async ({ idlePage, server }) => {
  server.setRoute('/slow', (req, res) => setTimeout(() => res.end('loaded'), 700));
  await idlePage.evaluate(() => {
    void fetch('/slow').then(r => r.text()).then(text => document.body.innerHTML = `<div id=late>${text}</div>`);
  });
  await expect(idlePage.locator('#late')).toHaveText('loaded', { timeout: 5000 });
});

it('should wait for a timer in an iframe', async ({ idlePage, server }) => {
  await idlePage.setContent(`<iframe src="${server.CROSS_PROCESS_PREFIX}/empty.html"></iframe>`);
  const frame = idlePage.frames()[1];
  await frame.waitForLoadState();
  await frame.evaluate(() => setTimeout(() => document.body.innerHTML = '<div id=late>late</div>', 600));
  await expect(idlePage.frameLocator('iframe').locator('#late')).toBeVisible({ timeout: 5000 });
});

it('should wait for an action that runs concurrently', async ({ idlePage }) => {
  await idlePage.setContent(`<button onclick="this.textContent = 'clicked'">click</button>`);
  const assertion = expect(idlePage.locator('button')).toHaveText('clicked', { timeout: 5000 });
  await idlePage.locator('button').click();
  await assertion;
});

it('should keep waiting while an animation frame loop runs', async ({ idlePage }) => {
  await idlePage.evaluate(() => {
    const loop = () => requestAnimationFrame(loop);
    loop();
  });
  const start = Date.now();
  await expect(idlePage.locator('#missing')).toBeVisible({ timeout: 1000 }).catch(() => {});
  expect(Date.now() - start).toBeGreaterThanOrEqual(900);
});

it('should keep waiting while a CSS animation runs', async ({ idlePage }) => {
  await idlePage.setContent(`<style>@keyframes spin { to { transform: rotate(360deg) } } div { animation: spin 1s infinite linear }</style><div>spinner</div>`);
  const start = Date.now();
  await expect(idlePage.locator('#missing')).toBeVisible({ timeout: 1000 }).catch(() => {});
  expect(Date.now() - start).toBeGreaterThanOrEqual(900);
});

it('should wait for the full timeout by default', async ({ page }) => {
  const start = Date.now();
  await expect(page.locator('#missing')).toBeVisible({ timeout: 1000 }).catch(() => {});
  expect(Date.now() - start).toBeGreaterThanOrEqual(900);
});
