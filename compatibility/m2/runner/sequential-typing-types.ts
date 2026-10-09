import type { Page } from 'flashwright';

/** Public typing options preserve the pinned call shape in ordinary TypeScript consumers. */
async function typing(page: Page): Promise<void> {
  await page.locator('input').pressSequentially('é😃', { delay: 1, timeout: 100, noWaitAfter: false });
  await page.keyboard.type('text', { delay: 1 });
  // @ts-expect-error Typing accepts strings only.
  await page.locator('input').pressSequentially(42);
  // @ts-expect-error Force has no meaning for typing.
  await page.locator('input').pressSequentially('text', { force: true });
  // @ts-expect-error Page keyboard typing has no per-call timeout.
  await page.keyboard.type('text', { timeout: 100 });
}
void typing;
