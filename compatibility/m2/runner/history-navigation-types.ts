import type { NavigationWaitOptions, Page, Response } from 'flashwright';

async function checkHistoryNavigationTypes(page: Page) {
  const options: NavigationWaitOptions = { timeout: 1000, waitUntil: 'commit' };
  const response: Response | null = await page.reload(options);
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await page.goForward({ timeout: 0, waitUntil: 'networkidle' });
  // @ts-expect-error History navigation does not accept a referer.
  await page.goBack({ referer: 'https://example.test' });
  // @ts-expect-error Only supported lifecycle values are accepted.
  await page.reload({ waitUntil: 'idle' });
  return response;
}
void checkHistoryNavigationTypes;
