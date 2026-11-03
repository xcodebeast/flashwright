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

test('codemod prints the rewrite of selector-based calls and leaves look-alikes', async ({ runCLICommand }) => {
  const result = await runCLICommand({
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('a', async ({ page }) => {
        await page.click('#submit', { force: true });
        await page.fill('#name', 'Ann');
        await page.type('#search', 'hi');
        await page.selectOption('#color', { label: 'Blue' });
        const href = await page.getAttribute('a', 'href');
        await page.dragAndDrop('#from', '#to');
        await page.waitForSelector('.loaded');
        await page.locator('#q').type('text');
        const input = page.locator('#x');
        await input.fill('value', { force: true });
        await input.press('Enter', { delay: 10 });
        await input.selectOption('blue', { force: true });
        await page.keyboard.press('Control+A');
        await page.keyboard.type('hello', { delay: 100 });
      });
    `,
  }, 'codemod');
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(`+        await page.locator('#submit').click({ force: true });`);
  expect(result.stdout).toContain(`+        await page.locator('#name').fill('Ann');`);
  expect(result.stdout).toContain(`+        await page.locator('#search').pressSequentially('hi');`);
  expect(result.stdout).toContain(`+        await page.locator('#color').selectOption({ label: 'Blue' });`);
  expect(result.stdout).toContain(`+        const href = await page.locator('a').getAttribute('href');`);
  expect(result.stdout).toContain(`+        await page.locator('#from').dragTo(page.locator('#to'));`);
  expect(result.stdout).toContain(`+        await page.locator('.loaded').first().waitFor();`);
  expect(result.stdout).toContain(`+        await page.locator('#q').pressSequentially('text');`);
  expect(result.stdout).not.toMatch(/^[-+].*(input\.|keyboard)/m);
  expect(result.stdout).toContain('Would rewrite 8 calls in 1 file.');
  expect(result.stdout).toContain('Nothing was written.');
  expect(fs.readFileSync(test.info().outputPath('a.spec.ts'), 'utf8')).toContain(`page.click('#submit'`);
});

test('codemod lists what it cannot rewrite', async ({ runCLICommand }) => {
  const result = await runCLICommand({
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('a', async ({ page }) => {
        const handle = await page.$('#legacy');
        const text = await page.$eval('#t', e => e.textContent);
        const el = await page.waitForSelector('.item');
        await page.waitForNavigation();
        await page.waitForTimeout(500);
        await page.goto('/', { waitUntil: 'networkidle' });
      });
    `,
  }, 'codemod');
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('No selector-based calls to rewrite.');
  expect(result.stdout).toContain('6 calls to change by hand:');
  expect(result.stdout).toContain('a.spec.ts:4:30  $() returns element handles');
  expect(result.stdout).toContain('a.spec.ts:5:28  $eval does not wait for the element');
  expect(result.stdout).toContain('a.spec.ts:6:26  waitForSelector returns an ElementHandle here');
  expect(result.stdout).toContain('a.spec.ts:7:15  waitForNavigation is deprecated');
  expect(result.stdout).toContain('a.spec.ts:8:15  waitForTimeout makes tests slow and flaky');
  expect(result.stdout).toContain(`a.spec.ts:9:15  'networkidle' is discouraged`);
});

test('codemod --write rewrites files that still pass', async ({ runCLICommand, runInlineTest, server }) => {
  server.setRoute('/page.html', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<input id=name><button id=go onclick="document.querySelector('#out').textContent = document.querySelector('#name').value">Go</button><div id=out></div>`);
  });
  const files = {
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('a', async ({ page }) => {
        await page.goto('${server.PREFIX}/page.html');
        await page.fill('#name', 'Ann');
        await page.click('#go');
        expect(await page.textContent('#out')).toBe('Ann');
      });
    `,
  };
  const result = await runCLICommand(files, 'codemod', ['--write', '--keep-first']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('Rewrote 3 calls in 1 file.');
  const rewritten = fs.readFileSync(test.info().outputPath('a.spec.ts'), 'utf8');
  expect(rewritten).toContain(`await page.locator('#name').first().fill('Ann');`);
  expect(rewritten).toContain(`await page.locator('#go').first().click();`);
  expect(rewritten).toContain(`expect(await page.locator('#out').first().textContent()).toBe('Ann');`);
  const run = await runInlineTest({ 'a.spec.ts': rewritten });
  expect(run.exitCode).toBe(0);
  expect(run.passed).toBe(1);
});
