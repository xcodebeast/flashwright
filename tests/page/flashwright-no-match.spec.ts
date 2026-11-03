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

import { test as it, expect } from './pageTest';

it('says that a role match is hidden and lists the others', async ({ page }) => {
  await page.setContent(`<button>Send</button><button>Cancel</button><button style="display:none">Submit</button>`);
  const error = await page.getByRole('button', { name: 'Submit' }).click({ timeout: 500 }).catch(e => e);
  expect(error.message).toContain(`  - waiting for getByRole('button', { name: 'Submit' })`);
  expect(error.message).toContain(`    - no element matched`);
  expect(error.message).toContain(`      - a hidden element matches: <button>Submit</button>`);
  expect(error.message).toContain(`      - buttons on the page: getByRole('button', { name: 'Send' }), getByRole('button', { name: 'Cancel' })`);
});

it('suggests a role match with a similar name', async ({ page }) => {
  await page.setContent(`<button>Submit order</button><button>Cancel</button>`);
  const error = await page.getByRole('button', { name: 'Submt order' }).click({ timeout: 500 }).catch(e => e);
  expect(error.message).toContain(`- similar buttons: getByRole('button', { name: 'Submit order' })`);
  expect(error.message).not.toContain('Cancel');
});

it('says which part of a chain stops matching', async ({ page }) => {
  await page.setContent(`<form id=f><button>Send</button></form><a href="#">Send</a>`);
  const error = await page.locator('#f').getByRole('link', { name: 'Send' }).click({ timeout: 500 }).catch(e => e);
  expect(error.message).toContain(`- locator('#f') matches 1 element, but getByRole('link', { name: 'Send' }) inside it matches none`);
  expect(error.message).toContain(`- no link inside it`);

  const nth = await page.getByRole('button').nth(3).click({ timeout: 500 }).catch(e => e);
  expect(nth.message).toContain(`- getByRole('button') matches 1 element, none at index 3`);
});

it('suggests text, test ids and placeholders that are close', async ({ page }) => {
  await page.setContent(`
    <div>Save changes</div>
    <div data-testid="submit-button">x</div>
    <input placeholder="Email address">
  `);
  const text = await page.getByText('save changes', { exact: true }).click({ timeout: 500 }).catch(e => e);
  expect(text.message).toContain(`- matches without exact: getByText('Save changes')`);
  const testId = await page.getByTestId('submit-btn').click({ timeout: 500 }).catch(e => e);
  expect(testId.message).toContain(`- similar elements: getByTestId('submit-button')`);
  const placeholder = await page.getByPlaceholder('E-mail').fill('x', { timeout: 500 }).catch(e => e);
  expect(placeholder.message).toContain(`- similar elements: getByRole('textbox', { name: 'Email address' })`);
});

it('points at iframes when nothing on the page is close', async ({ page }) => {
  await page.setContent(`<iframe srcdoc="<button>Go</button>"></iframe>`);
  const error = await page.getByRole('button', { name: 'Go' }).click({ timeout: 500 }).catch(e => e);
  expect(error.message).toContain(`- no button on the page`);
  expect(error.message).toContain(`- the page has iframes; elements inside them need frameLocator()`);
});

it('explains an assertion on a missing element', async ({ page }) => {
  await page.setContent(`<h1>Welcome</h1><button>Log out</button>`);
  const error = await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible({ timeout: 500 }).catch(e => e);
  expect(error.message).toContain(`- similar buttons: getByRole('button', { name: 'Log out' })`);
});

it('adds nothing when the element was found', async ({ page }) => {
  await page.setContent(`<button disabled>Send</button>`);
  const error = await page.getByRole('button', { name: 'Send' }).click({ timeout: 500 }).catch(e => e);
  expect(error.message).toContain('element is not enabled');
  expect(error.message).not.toContain('no element matched');
});
