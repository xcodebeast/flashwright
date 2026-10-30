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

// Flashwright: test options that turn off what a test does not need.

import { test, expect } from './playwright-test-fixtures';

test('should apply blockResources from test.use', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';

      const servePage = async page => {
        await page.route('http://example.test/**', route => route.fulfill({
          contentType: route.request().resourceType() === 'document' ? 'text/html' : 'text/css',
          body: route.request().resourceType() === 'document' ? '<link rel="stylesheet" href="/style.css"><img src="/image.png">' : 'body { color: red }',
        }));
        const failed = [];
        page.on('requestfailed', request => failed.push(request.resourceType()));
        await page.goto('http://example.test/');
        return failed;
      };

      test('loads everything by default', async ({ page }) => {
        expect(await servePage(page)).toEqual([]);
      });

      test.describe(() => {
        test.use({ blockResources: ['image', 'stylesheet'] });
        test('blocks images and stylesheets', async ({ page }) => {
          expect((await servePage(page)).sort()).toEqual(['image', 'stylesheet']);
        });
      });
    `,
  }, { workers: 1 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(2);
});

test('should apply locatorPolicy from the config and test.use', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `
      export default { use: { locatorPolicy: 'test-id' } };
    `,
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';

      test.beforeEach(async ({ page }) => {
        await page.setContent('<button data-testid="save">Save</button>');
      });

      test('finds elements by test id', async ({ page }) => {
        await page.getByTestId('save').click();
      });

      test('rejects other locators', async ({ page }) => {
        const error = await page.getByRole('button', { name: 'Save' }).click().catch(e => e);
        expect(error.message).toContain("locatorPolicy 'test-id' only allows getByTestId() locators");
      });

      test.describe(() => {
        test.use({ locatorPolicy: 'any' });
        test('allows any locator', async ({ page }) => {
          await page.getByRole('button', { name: 'Save' }).click();
        });
      });

      test('rejects them again', async ({ page }) => {
        const error = await page.locator('button').click().catch(e => e);
        expect(error.message).toContain("locatorPolicy 'test-id' only allows getByTestId() locators");
      });
    `,
  }, { workers: 1 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(4);
});

test('should mount components with locatorPolicy test-id', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';

      test.use({ baseURL: 'http://gallery.test/', locatorPolicy: 'test-id' });
      test.beforeEach(async ({ page }) => {
        await page.route('http://gallery.test/**', route => route.fulfill({ contentType: 'text/html', body: \`
          <div id="root"></div>
          <script>
            window.mount = ({ props }) => {
              document.getElementById('root').innerHTML = '<button data-testid="save">' + props.label + '</button>';
              document.querySelector('[data-testid=save]').onclick = e => e.target.textContent = 'Saved';
            };
          </script>
        \` }));
      });

      test('finds elements by test id in the component', async ({ mount }) => {
        const component = await mount('Save', { label: 'Save' });
        await component.getByTestId('save').click();
        await expect(component.getByTestId('save')).toHaveText('Saved');
        const error = await component.getByRole('button').click().catch(e => e);
        expect(error.message).toContain("locatorPolicy 'test-id' only allows getByTestId() locators");
      });
    `,
  }, { workers: 1 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(1);
});

const crossOriginFetchTest = (expected: string, options = '') => `
  import { test, expect } from '@playwright/test';
  import http from 'http';
  ${options}

  let server, port;
  test.beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', req.url === '/page' ? 'text/html' : 'text/plain');
      res.end(req.url === '/page' ? '<p>page</p>' : 'data');
    });
    // Both loopback addresses, however the browser resolves localhost.
    await new Promise(f => server.listen(0, '::', f));
    port = server.address().port;
  });
  test.afterAll(() => server.close());

  test('fetches from another origin', async ({ page }) => {
    await page.goto('http://127.0.0.1:' + port + '/page');
    const result = await page.evaluate(url => fetch(url).then(response => response.text(), () => 'blocked'), 'http://localhost:' + port + '/data');
    expect(result).toBe('${expected}');
  });
`;

test('should give every test a new context with isolation: strict', async ({ runInlineTest }) => {
  const files = (use: string) => ({
    'playwright.config.ts': `export default { workers: 1, use: ${use} };`,
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      for (const name of ['one', 'two'])
        test(name, async ({ context }) => console.log('%%' + context._guid));
    `,
  });
  // A recycled context is the same browser context in every test of the worker.
  const recycled = await runInlineTest(files(`{}`));
  expect(recycled.exitCode).toBe(0);
  expect(new Set(recycled.outputLines).size).toBe(1);
  const strict = await runInlineTest(files(`{ isolation: 'strict' }`));
  expect(strict.exitCode).toBe(0);
  expect(new Set(strict.outputLines).size).toBe(2);
});

test('should reject an unknown isolation', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `export default { use: { isolation: 'none' } };`,
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('pass', async ({ page }) => {});
    `,
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(`isolation must be 'recycled' or 'strict', not "none"`);
});

test('should turn off CORS with webSecurity: false', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'secure.spec.ts': crossOriginFetchTest('blocked'),
    'insecure.spec.ts': crossOriginFetchTest('data', 'test.use({ webSecurity: false });'),
  }, { workers: 2 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(2);
});

test('should reject webSecurity: false outside Chromium', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `export default { use: { browserName: 'firefox', webSecurity: false } };`,
    'a.spec.ts': crossOriginFetchTest('data'),
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('webSecurity: false is only supported in Chromium, not in firefox');
});

test('should apply failFastWhenIdle from test.use', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test.use({ failFastWhenIdle: true });
      test('fails early', async ({ page }) => {
        await page.setContent('<div>static</div>');
        const start = Date.now();
        const error = await expect(page.locator('#missing')).toBeVisible({ timeout: 10000 }).catch(e => e);
        expect(error.message).toContain('failing early (failFastWhenIdle)');
        expect(Date.now() - start).toBeLessThan(5000);
      });
    `,
  });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(1);
});
