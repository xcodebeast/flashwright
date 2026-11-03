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

import path from 'path';

import { test, expect } from './playwright-test-fixtures';

const SIMPLE_SERVER_PATH = path.join(__dirname, 'assets', 'simple-server.js');

function config(port1: number, port2: number) {
  return `
    module.exports = {
      projects: [
        {
          name: 'shop',
          testDir: 'shop',
          webServer: { command: 'node ${JSON.stringify(SIMPLE_SERVER_PATH).slice(1, -1)} ${port1}', url: 'http://localhost:${port1}/hello' },
          use: { baseURL: 'http://localhost:${port1}' },
        },
        {
          name: 'admin',
          testDir: 'admin',
          webServer: [{ command: 'node ${JSON.stringify(SIMPLE_SERVER_PATH).slice(1, -1)} ${port2}', port: ${port2} }],
          use: { baseURL: 'http://localhost:${port2}' },
        },
      ],
    };
  `;
}

const testFile = (port: number, otherPort: number) => `
  import { test, expect } from '@playwright/test';
  test('reaches its server only', async ({ baseURL }) => {
    expect(baseURL).toBe('http://localhost:${port}');
    expect(await (await fetch(baseURL + '/hello')).text()).toBe('hello');
    expect(await fetch('http://localhost:${otherPort}/hello').then(() => 'up', () => 'down')).toBe(process.env.BOTH ? 'up' : 'down');
  });
`;

test('each project starts its own web server', async ({ runInlineTest }, { workerIndex }) => {
  const port1 = workerIndex * 2 + 10600;
  const port2 = port1 + 1;
  const files = {
    'playwright.config.js': config(port1, port2),
    'shop/a.spec.ts': testFile(port1, port2),
    'admin/a.spec.ts': testFile(port2, port1),
  };

  const both = await runInlineTest(files, { workers: 1 }, { BOTH: '1' });
  expect(both.exitCode).toBe(0);
  expect(both.passed).toBe(2);

  // A project that does not run does not start its server.
  const shop = await runInlineTest(files, { project: 'shop' });
  expect(shop.exitCode).toBe(0);
  expect(shop.passed).toBe(1);
  const admin = await runInlineTest(files, { project: 'admin' });
  expect(admin.exitCode).toBe(0);
  expect(admin.passed).toBe(1);

  // Nor does a project whose tests are all filtered out.
  const filtered = await runInlineTest(files, { grep: 'nothing' }, { BOTH: '1' });
  expect(filtered.output).not.toContain('WebServer');
});

test('servers stop at the end of the run', async ({ runInlineTest }, { workerIndex }) => {
  const port = workerIndex * 2 + 10700;
  const result = await runInlineTest({
    'playwright.config.js': `
      module.exports = {
        projects: [{
          name: 'one',
          webServer: { command: 'node ${JSON.stringify(SIMPLE_SERVER_PATH).slice(1, -1)} ${port}', port: ${port} },
        }],
      };
    `,
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('a', async () => {});
    `,
  });
  expect(result.exitCode).toBe(0);
  await expect.poll(() => fetch(`http://localhost:${port}/hello`).then(() => 'up', () => 'down')).toBe('down');
});

test('a server that does not start fails the run', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.js': `
      module.exports = {
        projects: [{
          name: 'one',
          webServer: { command: 'node -e "process.exit(1)"', port: 10799 },
        }],
      };
    `,
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('a', async () => {});
    `,
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('Process from config.webServer was not able to start. Exit code: 1');
});
