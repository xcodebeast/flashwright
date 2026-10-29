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

import { browserTest as it, expect } from '../config/browserTest';

const content = `
  <title>Policy</title>
  <ul data-testid="list">
    <li data-testid="item"><span data-testid="name">One</span><button data-testid="remove">Remove</button></li>
    <li data-testid="item"><span data-testid="name">Two</span><button data-testid="remove">Remove</button></li>
    <li data-testid="item" hidden><span data-testid="name">Three</span></li>
  </ul>
  <iframe data-testid="frame" srcdoc="<button data-testid=inner>Inner</button>"></iframe>
`;

it('should allow test id locators and the methods that combine them', async ({ browser }) => {
  const context = await browser.newContext({ locatorPolicy: 'test-id' });
  const page = await context.newPage();
  await page.setContent(content);
  const items = page.getByTestId('item');
  await expect(items).toHaveCount(3);
  await expect(items.first().getByTestId('name')).toHaveText('One');
  await expect(items.last()).toBeHidden();
  await expect(items.nth(1).getByTestId('name')).toHaveText('Two');
  await expect(items.filter({ visible: true })).toHaveCount(2);
  await expect(items.filter({ has: page.getByTestId('remove') })).toHaveCount(2);
  await expect(items.filter({ hasNot: page.getByTestId('remove') })).toHaveCount(1);
  await expect(page.getByTestId('name').and(page.getByTestId('list').getByTestId('name'))).toHaveCount(3);
  await expect(page.getByTestId('name').or(page.getByTestId('remove'))).toHaveCount(5);
  await expect(page.getByTestId('list').locator(page.getByTestId('remove'))).toHaveCount(2);
  await expect(page.getByTestId('frame').contentFrame().getByTestId('inner')).toHaveText('Inner');
  await expect(items.first().describe('the first item')).toBeVisible();
  await items.first().getByTestId('remove').click();
  expect(await page.getByTestId('name').allTextContents()).toEqual(['One', 'Two', 'Three']);
  // Assertions about the page itself select no element.
  await expect(page).toHaveTitle('Policy');
  await expect(page).toMatchAriaSnapshot(`
    - list:
      - listitem:
        - text: One
        - button "Remove"
  `);
  await context.close();
});

it('should reject every other locator right away', async ({ browser }) => {
  const context = await browser.newContext({ locatorPolicy: 'test-id' });
  const page = await context.newPage();
  await page.setContent(content);
  const message = `locatorPolicy 'test-id' only allows getByTestId() locators`;
  const rejected = [
    () => page.getByRole('button', { name: 'Remove' }).first().click(),
    () => page.getByText('One').click({ timeout: 10000 }),
    () => page.getByLabel('Name').fill('x'),
    () => page.getByPlaceholder('Name').fill('x'),
    () => page.getByAltText('Logo').click(),
    () => page.getByTitle('Logo').click(),
    () => page.locator('li').count(),
    () => page.locator('//li').count(),
    () => page.locator('data-testid=item').count(),
    () => page.getByTestId('item').filter({ hasText: 'One' }).count(),
    () => page.getByTestId('item').filter({ hasNotText: 'One' }).count(),
    () => page.getByTestId('item').filter({ has: page.locator('button') }).count(),
    () => page.getByTestId('list').locator('li').count(),
    () => page.frameLocator('iframe').getByTestId('inner').click(),
    () => page.click('button'),
    () => page.$('button'),
    () => page.$$eval('li', elements => elements.length),
    () => page.waitForSelector('li'),
    () => expect(page.getByRole('list')).toBeVisible({ timeout: 10000 }),
  ];
  for (const call of rejected) {
    const start = Date.now();
    const error = await call().then(() => null, e => e);
    expect.soft(error?.message, String(call)).toContain(message);
    expect.soft(Date.now() - start, String(call)).toBeLessThan(5000);
  }
  const handle = await page.getByTestId('list').elementHandle();
  expect((await handle!.$('li').catch(e => e)).message).toContain(message);
  const error = await page.getByRole('button').click().catch(e => e);
  expect(error.message).toContain(`while querying "getByRole('button')"`);
  await context.close();
});

it('should allow any locator by default', async ({ browser }) => {
  for (const options of [{}, { locatorPolicy: 'any' as const }]) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    await page.setContent(content);
    await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(2);
    await expect(page.locator('li')).toHaveCount(3);
    await context.close();
  }
});
