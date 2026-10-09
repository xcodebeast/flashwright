import type { ElementHandle, Locator, SelectTextOptions } from 'flashwright';

async function consumer(locator: Locator, handle: ElementHandle<HTMLInputElement>) {
  const options: SelectTextOptions = { timeout: 200, force: false };
  const selected: void = await locator.selectText(options);
  const scrolled: void = await locator.scrollIntoViewIfNeeded({ timeout: 200 });
  await handle.selectText(options);
  await handle.scrollIntoViewIfNeeded({ timeout: 0 });
  // @ts-expect-error Selection force is boolean.
  await locator.selectText({ force: 'yes' });
  // @ts-expect-error Scrolling does not accept selection options.
  await handle.scrollIntoViewIfNeeded({ force: true });
  // @ts-expect-error Captured selection has no trial mode.
  await handle.selectText({ trial: true });
  void selected; void scrolled;
}
void consumer;
