import type { Page, Response, URLMatcher, WaitForNavigationOptions } from 'flashwright';

async function checkNavigationWaitTypes(page: Page) {
  const options: WaitForNavigationOptions = { waitUntil: 'commit', timeout: 1000, url: url => url.pathname === '/next' };
  const response: Response | null = await page.waitForNavigation(options);
  const nothing: void = await page.waitForURL(/next/, { timeout: 0 });
  const pattern: URLMatcher = new URLPattern({ pathname: '/next' });
  await page.waitForNavigation({ url: pattern });
  await page.waitForURL(pattern);
  page.frame({ url: pattern });
  // @ts-expect-error Response waits have a narrower pinned matcher contract.
  await page.waitForResponse(new URLPattern({ pathname: '/next' }));
  // @ts-expect-error URL predicates receive URL, not Response.
  await page.waitForNavigation({ url: (response: Response) => response.status() === 200 });
  // @ts-expect-error URL waits do not accept referer.
  await page.waitForURL('/next', { referer: 'https://example.test' });
  return { response, nothing };
}
void checkNavigationWaitTypes;
