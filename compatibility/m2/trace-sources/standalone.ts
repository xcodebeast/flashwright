import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const { chromium } = await import(process.env.FLASHWRIGHT_SOURCE_LIBRARY!);
const sourcePath = fileURLToPath(import.meta.url);
const originalSource = await readFile(sourcePath, 'utf8');
const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.tracing.start({ sources: true, screenshots: false, snapshots: false });
  for (const version of ['original', 'changed', 'missing']) {
    if (version !== 'original') await context.tracing.startChunk();
    const value: number = await page.evaluate(() => 42);
    if (value !== 42) throw Error('source capture changed the browser result');
    if (version === 'changed') await writeFile(sourcePath, originalSource + '\n// changed source at export\n');
    if (version === 'missing') await unlink(sourcePath);
    await context.tracing.stopChunk({ path: join(process.env.FLASHWRIGHT_SOURCE_OUTPUT!, `${version}.zip`) });
  }
  await context.tracing.stop();
} finally { await browser.close(); }
