import { test as base, expect } from '@playwright/test';

// A worker's tests share one grid session, so the session is marked failed once any of them fails.
let sessionFailed = false;

export const test = base.extend<{ reportToTestMu: void }>({
  reportToTestMu: [async ({ page }, use, testInfo) => {
    await use();
    if (testInfo.project.name !== 'testmu-chrome')
      return;
    sessionFailed ||= testInfo.status !== testInfo.expectedStatus;
    const action = {
      action: 'setTestStatus',
      arguments: {
        status: sessionFailed ? 'failed' : 'passed',
        remark: sessionFailed ? `${testInfo.title}: ${testInfo.error?.message ?? testInfo.status}` : '',
      },
    };
    // The grid reads this message from the connection; the page does not run it.
    await page.evaluate(() => {}, `lambdatest_action: ${JSON.stringify(action)}`).catch(() => {
      console.warn(`Could not update the TestMu AI session status after "${testInfo.title}".`);
    });
  }, { auto: true }],
});

export { expect };
