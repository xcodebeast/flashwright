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

// Flashwright: --adaptive-settle responds once the page is quiet after an action, instead of
// always waiting the full settle time, and still reports the action's result.

import { test, expect } from './fixtures';

const page = `
  <title>Title</title>
  <button>Save</button>
  <div role="status">Ready</div>
  <script>
    document.querySelector('button').onclick = async () => {
      const response = await fetch('/api');
      document.querySelector('[role=status]').textContent = await response.text();
    };
  </script>
`;

test('reports the result of an action that fetches', async ({ startClient, server }) => {
  server.setContent('/', page, 'text/html');
  server.setRoute('/api', async (req, res) => {
    await new Promise(f => setTimeout(f, 50));
    res.end('Saved');
  });
  const { client } = await startClient({ args: ['--adaptive-settle', '--timeout-settle=3000'] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const startTime = Date.now();
  const response = await client.callTool({ name: 'browser_click', arguments: { element: 'Save button', target: 'e2' } });
  // With a 3s settle, a fixed wait would take at least 6s (before and after the request).
  expect(Date.now() - startTime).toBeLessThan(2500);
  expect(response).toHaveResponse({
    snapshot: expect.stringContaining(`status [ref=e3]: Saved`),
  });
});

test('waits at most the settle time for a page that keeps changing', async ({ startClient, server }) => {
  server.setContent('/', `
    <title>Title</title>
    <button>Start</button>
    <div id="counter">0</div>
    <script>
      document.querySelector('button').onclick = () => setInterval(() => document.querySelector('#counter').textContent++, 10);
    </script>
  `, 'text/html');
  const { client } = await startClient({ args: ['--adaptive-settle', '--timeout-settle=400'] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const startTime = Date.now();
  await client.callTool({ name: 'browser_click', arguments: { element: 'Start button', target: 'e2' } });
  const elapsed = Date.now() - startTime;
  expect(elapsed).toBeGreaterThanOrEqual(400);
  expect(elapsed).toBeLessThan(2000);
});
