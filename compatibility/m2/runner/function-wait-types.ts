import type { Page, Frame, JSHandle, ElementHandle, PageWaitForFunctionOptions } from 'flashwright';

async function consumer(page: Page, frame: Frame, borrowed: JSHandle<{ answer: number }>) {
  const options: PageWaitForFunctionOptions = { polling: 'raf', timeout: 0 };
  const value: JSHandle<number> = await page.waitForFunction(argument => argument.answer, borrowed, options);
  const asyncValue: JSHandle<number> = await frame.waitForFunction(async () => 42, undefined, { polling: 10 });
  const element: ElementHandle<HTMLButtonElement> = await frame.waitForFunction(() => document.querySelector('button')!);
  const nested: JSHandle<number> = await page.waitForFunction(argument => argument.borrowed.answer, { borrowed });
  // @ts-expect-error Polling modes retain the pinned literal type.
  await page.waitForFunction(() => true, undefined, { polling: 'mutation' });
  // @ts-expect-error A borrowed handle unboxes to its actual value type.
  await frame.waitForFunction(argument => argument.missing, borrowed);
  // @ts-expect-error Numeric results do not expose ElementHandle APIs.
  const wrongElement: ElementHandle = await page.waitForFunction(() => 42);
  void value; void asyncValue; void element; void nested; void wrongElement;
}
void consumer;
