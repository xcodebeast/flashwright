import filesystem from 'node:fs/promises';
import { test, expect } from '@flashwright/test';
import { chromium, type BrowserContext } from 'flashwright';

const originalRead = filesystem.readFile;
let releaseStorage!: (contents: string) => void;
let storageEntered!: () => void;
const entered = new Promise<void>(resolve => { storageEntered = resolve; });
const storage = new Promise<string>(resolve => { releaseStorage = resolve; });
const moduleBrowser = process.env.TEST_WORKER_INDEX === undefined ? undefined : await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH! });
let pendingContext: Promise<BrowserContext> | undefined;

// The original public operation begins during module evaluation. Its storage
// read resumes only after the worker has installed its screenshot observer.
if (moduleBrowser) {
  filesystem.readFile = (async (path: unknown, ...arguments_: unknown[]) => {
    if (path === 'flashwright-pending-module-state.json') { storageEntered(); return storage; }
    return Reflect.apply(originalRead, filesystem, [path, ...arguments_]);
  }) as typeof filesystem.readFile;
  pendingContext = moduleBrowser.newContext({ storageState: 'flashwright-pending-module-state.json', viewport: { width: 160, height: 120 } });
  void pendingContext.catch(() => {});
  await entered;
}

test.afterAll(async () => {
  releaseStorage('{"cookies":[],"origins":[]}');
  filesystem.readFile = originalRead;
  await pendingContext?.catch(() => {});
  await moduleBrowser?.close();
});

test('pending module context @on @off', async () => {
  releaseStorage('{"cookies":[],"origins":[]}');
  const context = await pendingContext!;
  const page = await context.newPage();
  await page.goto(process.env.FLASHWRIGHT_TEST_BASE_URL!);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(page.isClosed()).toBe(false);
  await context.close();
});
