/* eslint-disable notice/notice */

import { test as baseTest } from "/retained/application/playwright/adapter.mjs";

export { expect } from "/retained/application/playwright/adapter.mjs";

export const test = baseTest.extend({
  page: async ({ page }, use) => {
    await page.goto(process.env.FLASHWRIGHT_APPLICATION_URL!);
    await use(page);
  },
});
