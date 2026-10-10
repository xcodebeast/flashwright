import type { Page } from 'flashwright';

/** Native insertion keeps the pinned string-only, option-free Promise contract. */
async function insertion(page: Page): Promise<void> {
  const result: void = await page.keyboard.insertText('é😃');
  void result;
  await page.keyboard.insertText('');
  // @ts-expect-error Text insertion accepts strings only.
  await page.keyboard.insertText(42);
  // @ts-expect-error Text insertion has no per-call delay or timeout options.
  await page.keyboard.insertText('text', { delay: 1 });
}
void insertion;
