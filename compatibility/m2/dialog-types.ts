import type { BrowserContext, Dialog, Page } from 'flashwright';
import type { Dialog as RunnerDialog } from '@flashwright/test';

/** Compile-only contracts for direct and aliased packed consumers. */
async function dialogTypes(page: Page, context: BrowserContext, dialog: Dialog): Promise<void> {
  const owner: Page | null = dialog.page();
  const metadata: string[] = [dialog.type(), dialog.message(), dialog.defaultValue()];
  const runnerDialog: RunnerDialog = dialog;
  await dialog.accept();
  await dialog.accept('replacement');
  await dialog.dismiss();
  const onDialog = (value: Dialog): void => { void value.dismiss(); };
  page.on('dialog', onDialog).off('dialog', onDialog);
  context.once('dialog', value => { const inferred: Dialog = value; void inferred.accept(); });
  page.prependOnceListener('dialog', onDialog);
  const fromPage: Dialog = await page.waitForEvent('dialog', { predicate: value => value.type() === 'prompt', timeout: 10 });
  const fromContext: Dialog = await context.waitForEvent('dialog', value => value.page() === page);
  await page.close({ runBeforeUnload: false });
  // @ts-expect-error The close option must be boolean.
  await page.close({ runBeforeUnload: 'false' });
  // @ts-expect-error Dialog prompt replacement must be a string.
  await dialog.accept(42);
  // @ts-expect-error Dismiss does not accept prompt text.
  await dialog.dismiss('replacement');
  // @ts-expect-error Dialog listeners receive a Dialog rather than a Page.
  page.on('dialog', (value: Page) => { void value; });
  void [owner, metadata, runnerDialog, fromPage, fromContext];
}
void dialogTypes;
