import { test as base, expect } from '@flashwright/test';
import type { Page } from 'flashwright';
import * as upstream from 'flashwright-upstream-runner/test';

for (const browserType of [upstream.chromium, upstream.firefox, upstream.webkit]) {
  const forbidden = async () => { throw new Error('Forbidden upstream browser backend entered'); };
  browserType.launch = forbidden; browserType.launchPersistentContext = forbidden;
  browserType.connect = forbidden; browserType.connectOverCDP = forbidden;
}
upstream.request.newContext = async () => { throw new Error('Forbidden upstream request backend entered'); };

class PageObject {
  constructor(readonly page: Page) {}
  async submit(value: string) { await this.page.getByLabel('Name').fill(value); await this.page.getByLabel('Name').press('Enter'); }
}
export const test = base.extend<{ greeting: string; pageObject: PageObject }>({
  greeting: ['hello', { option: true }],
  page: async ({ page }, use, testInfo) => {
    await page.goto('/');
    try { await use(page); }
    finally {
      await page.context().close();
      expect(page.isClosed()).toBe(true);
      await testInfo.attach('flashwright-context-disposed', { body: 'disposed', contentType: 'text/plain' });
    }
  },
  pageObject: async ({ page }, use) => { await use(new PageObject(page)); },
});
export { expect };
