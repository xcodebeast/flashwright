import type { Page, Request, Response } from 'flashwright';

async function checkRequestWaitTypes(page: Page) {
  const request: Request = await page.waitForRequest('/api', { timeout: 0 });
  await page.waitForRequest(/api/);
  await page.waitForRequest(value => value.method() === 'POST');
  await page.waitForRequest(async value => value.frame() === page.mainFrame());
  // @ts-expect-error Request predicates receive Request, not Response.
  await page.waitForRequest((response: Response) => response.status() === 200);
  // @ts-expect-error Request waits preserve the narrower pinned matcher contract.
  await page.waitForRequest(new URLPattern({ pathname: '/api' }));
  // @ts-expect-error Request waits do not accept navigation lifecycle options.
  await page.waitForRequest('/api', { waitUntil: 'load' });
  return request;
}
void checkRequestWaitTypes;
