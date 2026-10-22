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

// Flashwright: the instantAnimations context option.

import { browserTest as it, expect } from '../config/browserTest';
import type { Page } from 'playwright-core';

it.skip(({ browserName }) => browserName !== 'chromium', 'Chromium only');

// Ten-second animations, each with a delay; records when each one ends.
const animationsPage = `
  <style>
    #transition { transition: transform 10s ease-out 2s; }
    #transition.moved { transform: translateX(200px); }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    #animation { animation: fade 10s 3s both; }
  </style>
  <div id="transition">transition</div>
  <div id="animation">animation</div>
  <script>
    window.ended = [];
    document.getElementById('animation').addEventListener('animationend', () => ended.push('css animation'));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const element = document.getElementById('transition');
      element.addEventListener('transitionend', () => ended.push('css transition'));
      element.classList.add('moved');
      document.body.animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: 10000, delay: 1000 }).finished.then(() => ended.push('web animation'));
    }));
  </script>
`;

async function expectAnimationsToEnd(page: Page) {
  await page.waitForFunction(() => (window as any).ended.length === 3, null, { timeout: 2000 });
  expect((await page.evaluate(() => (window as any).ended)).sort()).toEqual(['css animation', 'css transition', 'web animation']);
}

it('should end animations right away', async ({ browser, server }) => {
  server.setRoute('/animations.html', (req, res) => res.end(animationsPage));
  const context = await browser.newContext({ instantAnimations: true });
  const page = await context.newPage();
  await page.goto(server.PREFIX + '/animations.html');
  await expectAnimationsToEnd(page);
  await page.reload();
  await expectAnimationsToEnd(page);

  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.evaluate(url => window.open(url), server.PREFIX + '/animations.html'),
  ]);
  await expectAnimationsToEnd(popup);
  await context.close();
});

it('should run animations at their speed by default', async ({ browser, server }) => {
  server.setRoute('/animations.html', (req, res) => res.end(animationsPage));
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.PREFIX + '/animations.html');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).ended)).toEqual([]);
  await context.close();
});

it('should end animations in cross-origin frames', async ({ browser, server }) => {
  server.setRoute('/animations.html', (req, res) => res.end(animationsPage));
  const context = await browser.newContext({ instantAnimations: true });
  const page = await context.newPage();
  await page.goto(server.EMPTY_PAGE);
  await page.setContent(`<iframe src="${server.CROSS_PROCESS_PREFIX}/animations.html"></iframe>`);
  const frame = page.frames()[1];
  await frame.waitForFunction(() => (window as any).ended?.length === 3, null, { timeout: 2000 });
  await context.close();
});
