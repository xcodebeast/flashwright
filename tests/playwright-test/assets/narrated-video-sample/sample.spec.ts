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

import { test, expect } from '@playwright/test';

// CI renders this with each system's own voice and keeps the video, for a person to listen to.

const page = `
  <style>
    body { font: 18px system-ui; margin: 60px auto; max-width: 480px; }
    input, button { font: inherit; padding: 8px 12px; }
    li { padding: 6px 0; }
  </style>
  <h1>Groceries</h1>
  <form onsubmit="event.preventDefault(); const li = document.createElement('li'); li.textContent = item.value; list.append(li); item.value = '';">
    <input id="item" aria-label="New item" placeholder="What do we need?">
    <button>Add</button>
  </form>
  <ul id="list"></ul>
`;

test('adds items to the list', async ({ page: tab, narrate }) => {
  await tab.setContent(page);
  await narrate('This is a small grocery list, and it starts empty.');
  await tab.getByLabel('New item').fill('Coffee');
  await narrate('We type the first item and add it.');
  await tab.getByRole('button', { name: 'Add' }).click();
  await expect(tab.getByRole('listitem')).toHaveText(['Coffee']);
  await tab.getByLabel('New item').fill('Bread');
  await tab.getByRole('button', { name: 'Add' }).click();
  await narrate('Each new item goes to the end of the list.');
  await expect(tab.getByRole('listitem')).toHaveText(['Coffee', 'Bread']);
});
