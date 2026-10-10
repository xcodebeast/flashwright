import filesystem from 'node:fs/promises';
import fixtures from './coordinator-fixtures.cjs';
const { test, expect, chromium } = fixtures;
const originalRead = filesystem.readFile;
let releaseStorage;
let enteredStorage;
const entered = new Promise(resolve => { enteredStorage = resolve; });
const storage = new Promise(resolve => { releaseStorage = resolve; });
const browser = process.env.TEST_WORKER_INDEX === undefined ? undefined : await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
let pendingContext;
let page;
if (browser) {
  filesystem.readFile = (path, ...parameters) => {
    if (path === 'pending-original-module-state.json') { enteredStorage(); return storage; }
    return Reflect.apply(originalRead, filesystem, [path, ...parameters]);
  };
  pendingContext = browser.newContext({ storageState: 'pending-original-module-state.json' });
  void pendingContext.catch(() => {});
  await entered;
}
test.afterAll(async () => {
  releaseStorage('{"cookies":[],"origins":[]}');
  filesystem.readFile = originalRead;
  await pendingContext?.catch(() => {});
  await browser?.close();
});
test('pending module publication keeps its original unclaimed ownership', async () => {
  releaseStorage('{"cookies":[],"origins":[]}');
  page = await (await pendingContext).newPage();
  await page.evaluate(() => { document.title = 'late module context'; });
  await expect(page).toHaveTitle('late module context');
});
test('later module boundary enrolls the published context', async () => {
  await expect(page).toHaveTitle('late module context');
});
