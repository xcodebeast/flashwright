import type { Readable } from 'node:stream';
import { chromium, type BrowserContextOptions, type Download, type Page } from 'flashwright';
import { defineConfig, test, type Download as RunnerDownload } from '@flashwright/test';

const contextOptions: BrowserContextOptions = { acceptDownloads: false };
defineConfig({ use: { acceptDownloads: true, contextOptions } });
test.use({ acceptDownloads: false, contextOptions });
test.extend<{ customDownloadPolicy: boolean }>({ customDownloadPolicy: [true, { option: true }] }).use({ acceptDownloads: true, customDownloadPolicy: false });

/** Compile every Download method and event/predicate form through the public package facades. */
async function consumer(page: Page) {
  const download: Download = await page.waitForEvent('download');
  const runnerDownload: RunnerDownload = download;
  const originalPage: Page = download.page();
  const url: string = download.url();
  const filename: string = download.suggestedFilename();
  const path: string = await download.path();
  const failure: string | null = await download.failure();
  const stream: Readable = await download.createReadStream();
  const saved: void = await download.saveAs('downloads/saved.txt');
  const canceled: void = await download.cancel();
  const deleted: void = await download.delete();
  page.on('download', received => { const typed: Download = received; void typed; });
  page.once('download', received => { const owner: Page = received.page(); void owner; });
  const filtered: Download = await page.waitForEvent('download', { timeout: 100, predicate: async received => received.suggestedFilename() === filename });
  await page.waitForEvent('download', received => received.url() === url);
  // @ts-expect-error Paths must be strings.
  await download.saveAs(42);
  // @ts-expect-error Download has no per-call timeout option.
  await download.path({ timeout: 100 });
  // @ts-expect-error Download predicates receive a Download, not a string.
  await page.waitForEvent('download', { predicate: (received: string) => received === filename });
  const browser = await chromium.launch();
  await browser.newContext(contextOptions);
  await browser.newPage({ acceptDownloads: true });
  // @ts-expect-error Download policy is boolean.
  await browser.newContext({ acceptDownloads: 'false' });
  // @ts-expect-error Runner download policy is boolean.
  test.use({ acceptDownloads: 'false' });
  // @ts-expect-error Nested runner context download policy is boolean.
  test.use({ contextOptions: { acceptDownloads: 1 } });
  void runnerDownload; void originalPage; void path; void failure; void stream;
  void saved; void canceled; void deleted; void filtered;
}
void consumer;
