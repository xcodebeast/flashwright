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
import { PNG } from 'playwright-core/lib/utilsBundle';

import { test, expect } from './playwright-test-fixtures';

// A fixture that outlives the context and fails in its teardown, after the context has closed.
const failingTeardown = `
  import { test as base, expect } from '@playwright/test';
  export const test = base.extend<{ failAfterContext: void }>({
    failAfterContext: [async ({}, use) => {
      await use();
      if (test.info().title.startsWith('fails'))
        throw new Error('teardown failed');
    }, { auto: true }],
  });
`;

function isRed(file: string) {
  const png = PNG.sync.read(fs.readFileSync(file));
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] < 200 || png.data[i + 1] > 60 || png.data[i + 2] > 60)
      return false;
  }
  return true;
}

test('a test that fails after its recycled context closed gets the screenshot of its page', async ({ runInlineTest }, testInfo) => {
  const result = await runInlineTest({
    'playwright.config.ts': `export default { use: { screenshot: 'only-on-failure', viewport: { width: 200, height: 100 } } };`,
    'helper.ts': failingTeardown,
    'a.spec.ts': `
      import { test } from './helper';
      test('passes', async ({ page }) => {
        await page.setContent('<style>body { margin: 0; background: rgb(0, 0, 255); }</style>');
      });
      test('fails in teardown', async ({ page }) => {
        await page.setContent('<style>body { margin: 0; background: rgb(255, 0, 0); }</style>');
      });
      test('passes again', async ({ page }) => {
        await page.setContent('<style>body { margin: 0; background: rgb(0, 0, 255); }</style>');
      });
    `,
  }, { workers: 1 });
  expect(result.passed).toBe(2);
  expect(result.failed).toBe(1);
  expect(result.output).toContain('teardown failed');
  const files = (name: string) => {
    const dir = testInfo.outputPath('test-results', name);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(file => file.endsWith('.png')) : [];
  };
  expect(files('a-passes')).toEqual([]);
  expect(files('a-passes-again')).toEqual([]);
  expect(files('a-fails-in-teardown')).toEqual(['test-failed-1.png']);
  expect(isRed(testInfo.outputPath('test-results', 'a-fails-in-teardown', 'test-failed-1.png'))).toBe(true);
});

test('a page with an open WebSocket is captured when its recycled context closes', async ({ runInlineTest, server }, testInfo) => {
  server.onceWebSocketConnection(() => {});
  const result = await runInlineTest({
    'playwright.config.ts': `export default { use: { screenshot: 'only-on-failure', viewport: { width: 200, height: 100 } } };`,
    'helper.ts': failingTeardown,
    'a.spec.ts': `
      import { test } from './helper';
      test('fails in teardown', async ({ page }) => {
        await page.setContent('<style>body { margin: 0; background: rgb(255, 0, 0); }</style>');
        await page.evaluate(url => new Promise(f => { const ws = new WebSocket(url); ws.onopen = f; (window as any).ws = ws; }), 'ws://localhost:${server.PORT}/ws');
      });
    `,
  }, { workers: 1 });
  expect(result.failed).toBe(1);
  const file = testInfo.outputPath('test-results', 'a-fails-in-teardown', 'test-failed-1.png');
  expect(isRed(file)).toBe(true);
});

test('a page waiting for its test to fail keeps the frame its transitions had when the context closed', async ({ runInlineTest }, testInfo) => {
  const result = await runInlineTest({
    'playwright.config.ts': `export default { use: { screenshot: 'only-on-failure', viewport: { width: 200, height: 100 } } };`,
    'helper.ts': failingTeardown.replace(`await use();`, `await use();
      await new Promise(f => setTimeout(f, 1000));`),
    'a.spec.ts': `
      import { test } from './helper';
      test('fails in teardown', async ({ page }) => {
        await page.setContent('<style>body { margin: 0; background: rgb(255, 0, 0); transition: background 2s linear; } body.blue { background: rgb(0, 0, 255); }</style>');
        await page.evaluate(() => document.body.classList.add('blue'));
      });
    `,
  }, { workers: 1 });
  expect(result.failed).toBe(1);
  expect(isRed(testInfo.outputPath('test-results', 'a-fails-in-teardown', 'test-failed-1.png'))).toBe(true);
});

test('a page with styles for the scripting media feature is captured with its scripts running', async ({ runInlineTest }, testInfo) => {
  const result = await runInlineTest({
    'playwright.config.ts': `export default { use: { screenshot: 'only-on-failure', viewport: { width: 200, height: 100 } } };`,
    'helper.ts': failingTeardown,
    'a.spec.ts': `
      import { test } from './helper';
      test('fails in teardown', async ({ page }) => {
        await page.setContent('<style>body { margin: 0; background: rgb(255, 0, 0); } @media (scripting: none) { body { background: rgb(0, 0, 255); } }</style>');
      });
    `,
  }, { workers: 1 });
  expect(result.failed).toBe(1);
  expect(isRed(testInfo.outputPath('test-results', 'a-fails-in-teardown', 'test-failed-1.png'))).toBe(true);
});

test('a page waits for its test to fail only for a moment', async ({ runInlineTest }, testInfo) => {
  // An SVG image that turns blue a moment after it shows, which moves by itself while the page waits.
  const image = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="rgb(255,0,0)"><set attributeName="fill" to="rgb(0,0,255)" begin="0.5s"/></rect></svg>`)}`;
  const result = await runInlineTest({
    'playwright.config.ts': `export default { use: { screenshot: 'only-on-failure', viewport: { width: 200, height: 100 } } };`,
    'helper.ts': failingTeardown.replace(`await use();`, `await use();
      await new Promise(f => setTimeout(f, 1000));`),
    'a.spec.ts': `
      import { test } from './helper';
      test('fails in teardown', async ({ page }) => {
        await page.setContent('<style>body { margin: 0; }</style><img style="display: block">');
        await page.evaluate(src => new Promise(f => {
          const img = document.querySelector('img');
          img.onload = f;
          img.src = src;
        }), ${JSON.stringify(image)});
      });
    `,
  }, { workers: 1 });
  expect(result.failed).toBe(1);
  expect(isRed(testInfo.outputPath('test-results', 'a-fails-in-teardown', 'test-failed-1.png'))).toBe(true);
});

test('a page with styles of another origin for the scripting media feature is captured with its scripts running', async ({ runInlineTest, server }, testInfo) => {
  server.setRoute('/scripting.css', (req, res) => {
    res.setHeader('content-type', 'text/css');
    // The name of the feature escaped, as CSS allows.
    res.end('body { margin: 0; background: rgb(255, 0, 0); } @media (scr\\69 pting: none) { body { background: rgb(0, 0, 255); } }');
  });
  server.setRoute('/page.html', (req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<link rel=stylesheet href="${server.CROSS_PROCESS_PREFIX}/scripting.css">`);
  });
  const result = await runInlineTest({
    'playwright.config.ts': `export default { use: { screenshot: 'only-on-failure', viewport: { width: 200, height: 100 } } };`,
    'helper.ts': failingTeardown,
    'a.spec.ts': `
      import { test } from './helper';
      test('fails in teardown', async ({ page }) => {
        await page.goto('${server.PREFIX}/page.html');
      });
    `,
  }, { workers: 1 });
  expect(result.failed).toBe(1);
  expect(isRed(testInfo.outputPath('test-results', 'a-fails-in-teardown', 'test-failed-1.png'))).toBe(true);
});

test('a page whose close listener closes the browser is still captured', async ({ runInlineTest }, testInfo) => {
  const result = await runInlineTest({
    'playwright.config.ts': `export default { use: { screenshot: 'only-on-failure', viewport: { width: 200, height: 100 } } };`,
    'helper.ts': failingTeardown,
    'a.spec.ts': `
      import { test } from './helper';
      test('fails in teardown', async ({ page, browser }) => {
        page.on('close', () => void browser.close());
        await page.setContent('<style>body { margin: 0; background: rgb(255, 0, 0); }</style>');
      });
    `,
  }, { workers: 1 });
  expect(result.failed).toBe(1);
  expect(isRed(testInfo.outputPath('test-results', 'a-fails-in-teardown', 'test-failed-1.png'))).toBe(true);
});

test('a page with a call in flight is captured before the call gets to settle', async ({ runInlineTest }, testInfo) => {
  const result = await runInlineTest({
    'playwright.config.ts': `export default { use: { screenshot: 'only-on-failure', viewport: { width: 200, height: 100 } } };`,
    'helper.ts': failingTeardown,
    'a.spec.ts': `
      import { test } from './helper';
      test('fails in teardown', async ({ page }) => {
        await page.setContent('<style>body { margin: 0; background: rgb(255, 0, 0); }</style>');
        // Turns the page blue while closing the context waits for the call to settle.
        page.evaluate(() => new Promise(f => setTimeout(() => document.body.style.background = 'rgb(0, 0, 255)', 40))).catch(() => {});
      });
    `,
  }, { workers: 1 });
  expect(result.failed).toBe(1);
  expect(isRed(testInfo.outputPath('test-results', 'a-fails-in-teardown', 'test-failed-1.png'))).toBe(true);
});
