import type { BrowserContext, Disposable, InitScript, Page } from 'flashwright';

/** Compile the public init-script forms without requiring a running browser. */
async function checkInitScriptTypes(page: Page, context: BrowserContext) {
  const source: InitScript<{ seed: string }> = argument => { window.name = argument.seed; };
  const registration: Disposable = await context.addInitScript(source, { seed: 'context' });
  await registration.dispose();
  await registration[Symbol.asyncDispose]();
  await page.addInitScript(() => { window.name = 'page'; });
  await page.addInitScript('window.name = "source";');
  await page.addInitScript({ content: 'window.name = "content";' });
  await page.addInitScript({ path: 'preload.js' });
  // @ts-expect-error The argument must match the function parameter.
  await page.addInitScript((seed: string) => { window.name = seed; }, 42);
  // @ts-expect-error Script content must be a string.
  await context.addInitScript({ content: 42 });
}
void checkInitScriptTypes;
