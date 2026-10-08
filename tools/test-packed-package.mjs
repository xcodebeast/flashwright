import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(resolve('.cache/packed-consumer-'));
const packed = JSON.parse(execFileSync('npm', ['pack', '--workspace', 'packages/flashwright', '--pack-destination', directory, '--json'], { encoding: 'utf8' }));
const archive = join(directory, packed[0].filename);
const runtimeArchive = process.env.FLASHWRIGHT_PACKAGED_RUNTIME_ARCHIVE;
const runtimePackageName = `@flashwright/driver-${process.platform}-${process.arch}`;
const dependencies = { flashwright: `file:${archive}`, '@types/node': '24.10.1', ...(runtimeArchive ? { [runtimePackageName]: `file:${resolve(runtimeArchive)}` } : {}) };
await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'flashwright-consumer-smoke', private: true, type: 'module', dependencies }, null, 2));
execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...(runtimeArchive ? ['--offline'] : [])], { cwd: directory, stdio: 'pipe' });
const body = `
const { createServer } = await import('node:http');
const { once } = await import('node:events');
const server = createServer((_request, response) => response.end('<title>Packed consumer</title><h1>real HTTP</h1><label>Name<input></label><button onclick="this.textContent=String(event.isTrusted)">Click</button><label><input type="checkbox">Check</label>'));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  assert.equal(await page.evaluate(value => value.answer, { answer: 42 }), 42);
  const parentHandle = await page.evaluateHandle(() => ({ child: { answer: 42 } }));
  const childHandle = await parentHandle.getProperty('child');
  await parentHandle.dispose();
  assert.equal(await page.evaluate(({ handle }) => handle.answer, { handle: childHandle }), 42);
  assert.deepEqual(await childHandle.jsonValue(), { answer: 42 });
  await childHandle.dispose();
  const elementHandle = await page.evaluateHandle(() => document.body);
  assert.equal(elementHandle.asElement(), elementHandle);
  assert.equal(await elementHandle.evaluate(element => element.tagName), 'BODY');
  await elementHandle[Symbol.asyncDispose]();
  const response = await page.goto('http://127.0.0.1:' + server.address().port);
  assert.equal(response.status(), 200);
  assert.equal(await page.title(), 'Packed consumer');
  const consoleEvent = page.context().waitForEvent('console');
  await page.evaluate(() => console.log('packed console', { answer: 42 }));
  const consoleMessage = await consoleEvent;
  assert.equal(consoleMessage.page(), page);
  assert.equal(consoleMessage.text(), 'packed console {answer: 42}');
  assert.deepEqual(await consoleMessage.args()[1].jsonValue(), { answer: 42 });
  for (const handle of consoleMessage.args()) await handle.dispose();
  const pageError = page.waitForEvent('pageerror');
  await page.evaluate(() => { setTimeout(() => { throw new TypeError('packed page error'); }, 0); });
  const error = await pageError;
  assert(error instanceof Error);
  assert.equal(error.name, 'TypeError');
  assert.equal(error.message, 'packed page error');
  assert.match(await response.text(), /real HTTP/);
  assert.equal(await page.getByRole('heading').textContent(), 'real HTTP');
  await page.getByLabel('Name').fill('packed input');
  assert.equal(await page.getByLabel('Name').inputValue(), 'packed input');
  await page.getByLabel('Name').press('ControlOrMeta+A');
  await page.keyboard.press('z');
  assert.equal(await page.getByLabel('Name').inputValue(), 'z');
  await page.getByRole('button', { name: 'Click' }).click();
  assert.equal(await page.getByRole('button').textContent(), 'true');
  await page.getByLabel('Check', { exact: true }).check();
  assert.equal(await page.getByLabel('Check', { exact: true }).isChecked(), true);
  await page.context().addCookies([{ name: 'packed', value: 'round trip', url: page.url() }]);
  await page.evaluate(() => localStorage.setItem('packed', 'stored'));
  const state = await page.context().storageState({ path: 'state.json' });
  for (const storageState of [state, 'state.json']) {
    const restored = await browser.newContext({ storageState });
    assert.equal((await restored.cookies())[0].value, 'round trip');
    const restoredPage = await restored.newPage();
    await restoredPage.goto(page.url());
    assert.equal(await restoredPage.evaluate(() => localStorage.getItem('packed')), 'stored');
    await restored.clearCookies({ name: /^packed$/ });
    assert.deepEqual(await restored.cookies(), []);
    await restored.close();
  }
  await page.close();
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
`;
await writeFile(join(directory, 'consumer.mjs'), `import assert from 'node:assert/strict';\nimport { chromium } from 'flashwright';\n${body}`);
await writeFile(join(directory, 'consumer.cjs'), `const assert = require('node:assert/strict');\nconst { chromium } = require('flashwright');\n(async () => { ${body} })().catch(error => { console.error(error); process.exitCode = 1; });`);
const typeBody = `
async function example(): Promise<number> {
  const browser: Browser = await chromium.launch();
  try {
    const context: BrowserContext = await browser.newContext();
    const page: Page = await context.newPage();
    const handle: import('flashwright').JSHandle<{ answer: number }> = await page.evaluateHandle(() => ({ answer: 42 }));
    const answer: number = await page.evaluate(({ nested }) => nested[0].answer, { nested: [handle] });
    const property: import('flashwright').JSHandle<number> = await handle.getProperty('answer');
    const next: number = await property.evaluate((value, argument) => value + argument.answer, handle);
    const element: import('flashwright').ElementHandle<HTMLButtonElement> = await page.evaluateHandle(() => document.createElement('button'));
    const unboxedElement: import('flashwright').ElementHandle<HTMLButtonElement> = element.asElement();
    const notElement: null = handle.asElement();
    const frameHandle: import('flashwright').JSHandle<number> = await page.mainFrame().evaluateHandle(() => 42);
    // @ts-expect-error Handle arguments preserve their underlying value type.
    await page.evaluate(value => value.missing, handle);
    // @ts-expect-error Element handles preserve their DOM subtype.
    await element.evaluate(value => value.notAnElementMember);
    void answer; void next; void unboxedElement; void notElement; void frameHandle;
    page.on('pageerror', error => {
      const message: string = error.message;
      // @ts-expect-error Page errors must not erase their type to any.
      const missing: number = error.missing;
      void message; void missing;
    });
    const pageError: Error = await page.waitForEvent('pageerror', { predicate: error => error.name === 'TypeError' });
    void pageError;
    const chainedPage: Page = page.on('console', message => {
      const text: string = message.text();
      const handles: import('flashwright').JSHandle[] = message.args();
      const type: import('flashwright').ConsoleMessageType = message.type();
      // @ts-expect-error Console callbacks preserve the message type.
      const missing: number = message.missing;
      void text; void handles; void type; void missing;
    });
    const chainedContext: BrowserContext = context.prependOnceListener('console', message => {
      const page: Page | null = message.page(); void page;
    });
    const consoleMessage: import('flashwright').ConsoleMessage = await context.waitForEvent('console', message => message.text() === 'typed');
    const pageConsole: import('flashwright').ConsoleMessage = await page.waitForEvent('console');
    void chainedPage; void chainedContext; void consoleMessage; void pageConsole;
    const cookie: import('flashwright').SetCookie = { name: 'typed', value: 'value', url: 'https://example.test' };
    await context.addCookies([cookie]);
    const cookies: import('flashwright').Cookie[] = await context.cookies(['https://example.test']);
    const state: import('flashwright').StorageState = await context.storageState({ path: 'state.json', indexedDB: false });
    await context.clearCookies({ name: /typed/, domain: 'example.test' });
    const restored: BrowserContext = await browser.newContext({ storageState: state });
    await restored.close();
    void cookies;
    const locator: import('flashwright').Locator = page.getByRole('button', { name: /submit/i });
    const count: number = await locator.count();
    const visible: boolean = await locator.isVisible();
    const options: import('flashwright').ClickOptions = { button: 'left', modifiers: ['ControlOrMeta'], position: { x: 3, y: 4 }, trial: true };
    const pressOptions: import('flashwright').PressOptions = { delay: 5, noWaitAfter: true };
    await locator.press('Enter', pressOptions);
    const keyboard: import('flashwright').Keyboard = page.keyboard;
    await keyboard.press('Enter', { delay: 1 });
    await locator.click(options);
    await locator.dblclick({ delay: 5 });
    await locator.hover({ force: true });
    await locator.setChecked(true, { noWaitAfter: true });
    void count; void visible;
    const value: number = await page.evaluate(({ number }) => number + 1, { number: 2 });
    return value;
  } finally { await browser.close(); }
}
void example;
`;
await writeFile(join(directory, 'consumer.mts'), `import { chromium, type Browser, type BrowserContext, type Page } from 'flashwright';\n${typeBody}`);
await writeFile(join(directory, 'consumer.cts'), `import { chromium, type Browser, type BrowserContext, type Page } from 'flashwright';\n${typeBody}`);
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.mts', 'consumer.cts'], { cwd: directory, stdio: 'inherit' });
const environment = { ...process.env, FLASHWRIGHT_DRIVER_PATH: process.env.FLASHWRIGHT_DRIVER_PATH ?? resolve('target/debug/flashwright-driver'), FLASHWRIGHT_BROWSER_PATH: process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath() };
if (runtimeArchive) {
  delete environment.FLASHWRIGHT_DRIVER_PATH;
  environment.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
  const compilerProbe = await import('node:child_process').then(({ spawnSync }) => spawnSync('cargo', ['--version'], { env: environment }));
  assert.equal(compilerProbe.error?.code, 'ENOENT', 'Packed runtime consumers must not have Cargo available');
}
const runtimePackagePath = runtimeArchive ? createRequire(join(directory, 'package.json')).resolve(`${runtimePackageName}/package.json`) : undefined;
const selectedDriver = runtimePackagePath ? join(dirname(runtimePackagePath), 'bin/flashwright-driver') : environment.FLASHWRIGHT_DRIVER_PATH;
for (const entry of ['consumer.mjs', 'consumer.cjs']) {
  execFileSync('python3', [resolve('tools/watchdog.py'), '--timeout', '60', '--', process.execPath, join(directory, entry)], { cwd: directory, env: environment, stdio: 'inherit' });
}
// Deliberately skew the installed runtime hash: incompatibility must reject before launch.
const runtimeVersionPath = join(directory, 'node_modules/flashwright/dist/commonjs/runtime-version.cjs');
const originalRuntimeVersion = await readFile(runtimeVersionPath);
await writeFile(runtimeVersionPath, "exports.residentRuntimeSha256 = 'deliberately-incompatible';\n");
await writeFile(join(directory, 'incompatible.mjs'), `import assert from 'node:assert/strict';\nimport { chromium } from 'flashwright';\nawait assert.rejects(chromium.launch(), error => error.name === 'ProtocolError' && (error.message.includes('mismatch') || error.message.includes('does not match')));\n`);
execFileSync('python3', [resolve('tools/watchdog.py'), '--timeout', '15', '--', process.execPath, join(directory, 'incompatible.mjs')], { cwd: directory, env: environment, stdio: 'inherit' });
await writeFile(runtimeVersionPath, originalRuntimeVersion);
const installed = JSON.parse(await readFile(join(directory, 'node_modules/flashwright/package.json'), 'utf8'));
assert.equal(installed.version, '0.0.0');
const reportDirectory = process.env.FLASHWRIGHT_PACKED_REPORT_DIRECTORY ?? 'compatibility/evidence';
await mkdir(reportDirectory, { recursive: true });
const evidence = {
  node: process.version, platform: process.platform, architecture: process.arch,
  package: packed[0].filename, archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
  consumerDirectory: directory, runtimeOverride: environment.FLASHWRIGHT_DRIVER_PATH ?? null,
  packagedRuntime: runtimePackagePath ? { packageName: runtimePackageName, archiveSha256: createHash('sha256').update(await readFile(runtimeArchive)).digest('hex'), manifest: JSON.parse(await readFile(join(dirname(runtimePackagePath), 'runtime.json'), 'utf8')), installation: 'offline local tarballs, lifecycle scripts disabled, Cargo absent from consumer PATH' } : null,
  driverSha256: createHash('sha256').update(await readFile(selectedDriver)).digest('hex'),
  checks: ['npm packed tarball', 'fresh consumer install', 'ESM runtime', 'CommonJS runtime', 'NodeNext ESM declarations', 'NodeNext CommonJS declarations', 'evaluation generic inference', 'typed page error listeners and event waits in both module formats', 'console live handles, context event waits and fluent typed listeners in both module formats', 'cookie and object/file storage-state round trips with public declarations', 'locator declarations, selection and native text input', 'native trusted click, checkbox input and keyboard shortcuts with public option types', 'owned browser cleanup', 'real HTTP navigation and response body', 'incompatible resident runtime rejected before launch'],
  remaining: ['Published platform runtime acquisition', 'pnpm and Yarn consumer matrix', 'package aliases'],
};
const destination = join(reportDirectory, `packed-library-${process.platform}-${process.arch}-${process.versions.node}.json`);
await writeFile(destination, JSON.stringify(evidence, null, 2) + '\n');
console.log(`Packed library consumers passed: ${destination}`);
