import type { Page, Frame, Locator, ElementHandle, FilePayload, InputFiles, SetInputFilesOptions, FileChooser } from 'flashwright';

async function consumer(page: Page, frame: Frame, locator: Locator, handle: ElementHandle<HTMLInputElement>) {
  const payload: FilePayload = { name: 'file.txt', mimeType: 'text/plain', buffer: Buffer.from('content') };
  const files: InputFiles = [payload];
  const options: SetInputFilesOptions = { timeout: 100, noWaitAfter: true };
  const chooser: FileChooser = await page.waitForEvent('filechooser');
  const input: ElementHandle<HTMLInputElement> = chooser.element();
  const multiple: boolean = chooser.isMultiple();
  const owner: Page = chooser.page();
  await chooser.setFiles(files, options);
  page.on('filechooser', event => { void event.setFiles([]); });
  void input; void multiple; void owner;
  const result: void = await page.setInputFiles('input', files, { ...options, strict: true });
  await frame.setInputFiles('input', 'local.txt');
  await locator.setInputFiles(payload, options);
  await handle.setInputFiles([], options);
  // @ts-expect-error Locators are always strict.
  await locator.setInputFiles([], { strict: false });
  // @ts-expect-error Buffer is required for an in-memory file.
  await page.setInputFiles('input', { name: 'file', mimeType: '', buffer: 'content' });
  // @ts-expect-error A path list cannot mix buffers.
  await handle.setInputFiles(['local.txt', payload]);
  // @ts-expect-error File assignment has no force option.
  await frame.setInputFiles('input', payload, { force: true });
  void result;
}
void consumer;
