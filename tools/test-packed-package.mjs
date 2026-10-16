import { installPackedConsumer, cleanupPackedConsumer } from './install-packed-consumer.mjs';
import { runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';
import { tmpdir } from 'node:os';
import { packConsumerPackages } from './packed-artifacts.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'flashwright-packed-consumer-'));
const { archives, dependencies: packageDependencies } = await packConsumerPackages(directory);
const archive = archives.flashwright;
const runtimeArchive = process.env.FLASHWRIGHT_PACKAGED_RUNTIME_ARCHIVE;
const runtimePackageName = `@flashwright/driver-${process.platform}-${process.arch}`;
const dependencies = { ...packageDependencies, '@types/node': '24.10.1', ...(runtimeArchive ? { [runtimePackageName]: '0.0.0' } : {}) };
await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'flashwright-consumer-smoke', private: true, type: 'module', dependencies }, null, 2));
const installation = await installPackedConsumer(directory, [...Object.values(archives), ...(runtimeArchive ? [resolve(runtimeArchive)] : [])]);
const body = `
const { createServer } = await import('node:http');
const { once } = await import('node:events');
const { readFile, stat } = await import('node:fs/promises');
const downloadBytes = Buffer.from([0, 255, 65, 195, 169, 0]);
const server = createServer((request, response) => {
  if (request.url === '/packed-download') {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="packed.bin"' });
    response.end(downloadBytes);
    return;
  }
  response.end('<title>Packed consumer</title><h1>real HTTP</h1><label>Name<input></label><button onclick="this.textContent=String(event.isTrusted)">Click</button><label><input type="checkbox">Check</label><a href="/packed-download">Packed download</a>');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const browser = await chromium.launch({ slowMo: 0 });
try {
  const disabled = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true });
  try {
    const disabledPage = await disabled.newPage();
    await disabledPage.goto('http://127.0.0.1:' + server.address().port);
    await disabledPage.getByRole('button', { name: 'Click' }).click();
    assert.equal(await disabledPage.getByRole('button').textContent(), 'Click');
    assert.equal(await disabledPage.evaluate(() => 42), 42);
  } finally { await disabled.close(); }
  const scriptedContext = await browser.newContext();
  const contextScript = await scriptedContext.addInitScript(value => { globalThis.contextSeed = value; }, { text: 'packed context' });
  const scriptedPage = await scriptedContext.newPage();
  assert.deepEqual(await scriptedPage.evaluate(() => globalThis.contextSeed), { text: 'packed context' });
  const pageScript = await scriptedPage.addInitScript({ content: 'globalThis.pageSeed = "packed page";' });
  assert.equal(await scriptedPage.evaluate(() => globalThis.pageSeed), undefined);
  await scriptedPage.goto('http://127.0.0.1:' + server.address().port);
  assert.deepEqual(await scriptedPage.evaluate(() => [globalThis.contextSeed, globalThis.pageSeed]), [{ text: 'packed context' }, 'packed page']);
  await contextScript.dispose(); await pageScript[Symbol.asyncDispose]();
  await scriptedPage.goto('http://127.0.0.1:' + server.address().port);
  assert.deepEqual(await scriptedPage.evaluate(() => [globalThis.contextSeed, globalThis.pageSeed]), [undefined, undefined]);
  await scriptedContext.close();
  const page = await browser.newPage();
  assert.equal(await page.setContent('<title>Packed content</title><p>replacement</p>', { waitUntil: 'domcontentloaded', timeout: 3000 }), undefined);
  assert.equal(await page.title(), 'Packed content');
  assert.equal(await page.locator('p').textContent(), 'replacement');
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
  const observedRequest = page.waitForRequest('**/packed-request');
  await page.evaluate(() => fetch('/packed-request').then(() => undefined));
  const packedRequest = await observedRequest;
  assert.equal(packedRequest.method(), 'GET');
  assert.equal(packedRequest.frame(), page.mainFrame());
  assert.ok(packedRequest.url().endsWith('/packed-request'));
  const routedRequests = [];
  await page.context().route('**/packed-route', async (route, request) => {
    routedRequests.push(request);
    assert.equal(request.headerValue('x-packed') instanceof Promise, true);
    assert.equal(await request.headerValue('x-packed'), 'yes');
    await route.fulfill({ json: { packed: true } });
  });
  const routing = await page.route('**/packed-route', async (route, request) => {
    routedRequests.push(request);
    await route.fallback({ headers: { ...request.headers(), 'X-Packed': 'yes' } });
  });
  assert.deepEqual(await page.evaluate(() => fetch('/packed-route').then(response => response.json())), { packed: true });
  assert.equal(routedRequests.length, 2);
  assert.equal(routedRequests[0], routedRequests[1]);
  assert.equal(routedRequests[0].frame(), page.mainFrame());
  await routing.dispose(); await page.context().unrouteAll({ behavior: 'wait' });
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
  const selectedHeading = await page.waitForSelector('h1', { strict: true });
  assert.equal(await selectedHeading.evaluate(element => element.textContent), 'real HTTP');
  await selectedHeading.dispose();
  assert.equal(await page.getByRole('heading').evaluate(element => element.ownerDocument === document), true);
  const evaluatedHeading = await page.getByRole('heading').evaluateHandle(element => element);
  assert.equal(await evaluatedHeading.evaluate(element => element.textContent), 'real HTTP');
  await evaluatedHeading.dispose();
  assert.equal(await page.waitForSelector('#missing', { state: 'hidden' }), null);
  await page.fill('input:not([type=checkbox])', 'selector input', { strict: true });
  await page.mainFrame().press('input:not([type=checkbox])', 'ControlOrMeta+A', { strict: false });
  await page.type('input:not([type=checkbox])', 'typed');
  assert.equal(await page.getByLabel('Name').inputValue(), 'typed');
  await page.setChecked('input[type=checkbox]', true, { strict: true });
  await page.mainFrame().uncheck('input[type=checkbox]');
  assert.equal(await page.getByLabel('Check', { exact: true }).isChecked(), false);
  await page.evaluate(() => {
    const frame = document.createElement('iframe'); frame.id = 'packed-frame';
    frame.srcdoc = '<input aria-label="Frame name"><button onclick="this.textContent=String(event.isTrusted)">Frame button</button>';
    document.body.append(frame);
  });
  const packedFrame = page.frameLocator('#packed-frame');
  assert(packedFrame instanceof FrameLocator);
  await packedFrame.getByLabel('Frame name').fill('inside frame');
  assert.equal(await page.locator('#packed-frame').contentFrame().getByLabel('Frame name').inputValue(), 'inside frame');
  await packedFrame.getByRole('button').click();
  assert.equal(await packedFrame.getByRole('button').evaluate(element => element.textContent), 'true');
  assert.equal(await packedFrame.owner().getAttribute('id'), 'packed-frame');
  await page.getByLabel('Name').fill('packed input');
  assert.equal(await page.getByLabel('Name').inputValue(), 'packed input');
  await page.getByLabel('Name').press('ControlOrMeta+A');
  await page.keyboard.press('z');
  assert.equal(await page.getByLabel('Name').inputValue(), 'z');
  await page.getByLabel('Name').pressSequentially('A+');
  await page.keyboard.type('é😃');
  assert.equal(await page.getByLabel('Name').inputValue(), 'zA+é😃');
  await page.getByLabel('Name').selectText();
  await page.keyboard.insertText('packed insertioné😃');
  assert.equal(await page.getByLabel('Name').inputValue(), 'packed insertioné😃');
  await page.getByLabel('Name').fill('zA+é😃');
  await page.getByLabel('Name').selectText();
  const selectedName = await page.getByLabel('Name').elementHandle();
  assert.equal(await selectedName.evaluate(element => element.selectionEnd), 'zA+é😃'.length);
  await selectedName.scrollIntoViewIfNeeded();
  await selectedName.selectText({ force: true });
  await page.getByLabel('Name').scrollIntoViewIfNeeded();
  assert.equal(await selectedName.evaluate(element => element.selectionStart), 0);
  await selectedName.dispose();
  await page.evaluate(() => { const input = document.createElement('input'); input.id = 'packed-file'; input.type = 'file'; document.body.append(input); });
  await page.setInputFiles('#packed-file', { name: 'packed.txt', mimeType: '', buffer: Buffer.from([0, 255, 65]) });
  const packedFile = await page.locator('#packed-file').elementHandle();
  assert.deepEqual(await packedFile.evaluate(async input => [input.files[0].name, input.files[0].type, [...new Uint8Array(await input.files[0].arrayBuffer())]]), ['packed.txt', 'text/plain', [0, 255, 65]]);
  await packedFile.setInputFiles([]);
  assert.equal(await packedFile.evaluate(input => input.files.length), 0);
  const chooserOpened = page.waitForEvent('filechooser');
  await page.locator('#packed-file').click();
  const chooser = await chooserOpened;
  assert.equal(chooser.page(), page); assert.equal(chooser.isMultiple(), false);
  assert.equal(chooser.element(), chooser.element());
  await chooser.setFiles({ name: 'choice.txt', mimeType: '', buffer: Buffer.from('chosen') });
  assert.equal(await packedFile.evaluate(async input => input.files[0].text()), 'chosen');
  await chooser.element().dispose();
  await packedFile.evaluate(input => input.remove());
  await packedFile.dispose();
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
  const downloadStarted = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Packed download' }).click();
  const download = await downloadStarted;
  assert(download instanceof Download);
  assert.equal(download.page(), page);
  assert.equal(download.url(), new URL('/packed-download', page.url()).href);
  assert.equal(download.suggestedFilename(), 'packed.bin');
  const temporaryPath = await download.path();
  assert.deepEqual(await readFile(temporaryPath), downloadBytes);
  assert.equal(await download.failure(), null);
  await download.saveAs('downloads/packed-copy.bin');
  assert.deepEqual(await readFile('downloads/packed-copy.bin'), downloadBytes);
  const downloadChunks = [];
  for await (const chunk of await download.createReadStream()) downloadChunks.push(chunk);
  assert.deepEqual(Buffer.concat(downloadChunks), downloadBytes);
  await download.cancel();
  await download.delete();
  assert.equal(await stat(temporaryPath).then(() => true, () => false), false);
  assert.deepEqual(await readFile('downloads/packed-copy.bin'), downloadBytes);
  assert.equal(download.page(), page);
  assert.equal(download.suggestedFilename(), 'packed.bin');
  await page.close();
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
`;
await writeFile(join(directory, 'consumer.mjs'), `import assert from 'node:assert/strict';\nimport { chromium, FrameLocator, Download } from 'flashwright';\n${body}`);
await writeFile(join(directory, 'consumer.cjs'), `const assert = require('node:assert/strict');\nconst { chromium, FrameLocator, Download } = require('flashwright');\n(async () => { ${body} })().catch(error => { console.error(error); process.exitCode = 1; });`);
const typeBody = `
async function example(): Promise<number> {
  const browser: Browser = await chromium.launch({ slowMo: 0 });
  try {
    const context: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true, javaScriptEnabled: false, acceptDownloads: true });
    // @ts-expect-error Context settings preserve boolean option types.
    await browser.newContext({ javaScriptEnabled: 'false' });
    // @ts-expect-error Download policy preserves boolean option types.
    await browser.newContext({ acceptDownloads: 'false' });
    const page: Page = await context.newPage();
    const waitedRequest = await page.waitForRequest(async request => request.method() === 'POST', { timeout: 1000 });
    const requestURL: string = waitedRequest.url();
    // @ts-expect-error A request predicate cannot read response-only status.
    await page.waitForRequest(request => request.status() === 200);
    void requestURL;
    const replacedContent: void = await page.setContent('<p>packed</p>', { waitUntil: 'load', timeout: 1000 });
    // @ts-expect-error Content replacement accepts text, not a binary buffer.
    await page.setContent(Buffer.from('packed'));
    // @ts-expect-error Content replacement preserves navigation lifecycle option types.
    await page.setContent('packed', { waitUntil: 'paint' });
    const insertedText: void = await page.keyboard.insertText('packedé😃');
    await page.keyboard.insertText('');
    // @ts-expect-error Native text insertion accepts strings only.
    await page.keyboard.insertText(42);
    // @ts-expect-error Native text insertion has no delay/timeout option object.
    await page.keyboard.insertText('text', { delay: 1 });
    void insertedText;
    const download: import('flashwright').Download = await page.waitForEvent('download', { predicate: received => received.suggestedFilename() === 'packed.bin' });
    const downloadPage: Page = download.page();
    const downloadURL: string = download.url();
    const downloadFilename: string = download.suggestedFilename();
    const downloadPath: string = await download.path();
    const downloadFailure: string | null = await download.failure();
    const downloadStream: import('node:stream').Readable = await download.createReadStream();
    const savedDownload: void = await download.saveAs('saved.bin');
    const canceledDownload: void = await download.cancel();
    const deletedDownload: void = await download.delete();
    // @ts-expect-error Download destinations are strings.
    await download.saveAs(42);
    void downloadPage; void downloadURL; void downloadFilename; void downloadPath; void downloadFailure;
    void downloadStream; void savedDownload; void canceledDownload; void deletedDownload;
    const registration: import('flashwright').Disposable = await context.addInitScript(({ name }: { name: string }) => { window.name = name; }, { name: 'packed' });
    await registration.dispose(); await registration[Symbol.asyncDispose]();
    await page.addInitScript({ content: 'window.name = "packed";' });
    // @ts-expect-error Init-script function arguments preserve their value type.
    await page.addInitScript((value: string) => { window.name = value; }, 42);
    const handle: import('flashwright').JSHandle<{ answer: number }> = await page.evaluateHandle(() => ({ answer: 42 }));
    const answer: number = await page.evaluate(({ nested }) => nested[0].answer, { nested: [handle] });
    const property: import('flashwright').JSHandle<number> = await handle.getProperty('answer');
    const next: number = await property.evaluate((value, argument) => value + argument.answer, handle);
    const element: import('flashwright').ElementHandle<HTMLButtonElement> = await page.evaluateHandle(() => document.createElement('button'));
    const unboxedElement: import('flashwright').ElementHandle<HTMLButtonElement> = element.asElement();
    const notElement: null = handle.asElement();
    const frameHandle: import('flashwright').JSHandle<number> = await page.mainFrame().evaluateHandle(() => 42);
    const selectedInput: import('flashwright').ElementHandle<HTMLInputElement> = await page.waitForSelector('input');
    await selectedInput.selectText({ force: true, timeout: 100 });
    const chooser: import('flashwright').FileChooser = await page.waitForEvent('filechooser');
    const chooserElement: import('flashwright').ElementHandle<HTMLInputElement> = chooser.element();
    await chooser.setFiles([]); void chooserElement;
    const upload: import('flashwright').FilePayload = { name: 'packed.txt', mimeType: '', buffer: Buffer.from('packed') };
    await selectedInput.setInputFiles(upload, { noWaitAfter: true });
    await page.mainFrame().setInputFiles('input', [upload], { strict: false, timeout: 100 });
    // @ts-expect-error File upload requires a Buffer.
    await page.setInputFiles('input', { name: 'file', mimeType: '', buffer: 'text' });
    await selectedInput.scrollIntoViewIfNeeded({ timeout: 100 });
    await page.click('button', { strict: false, trial: true });
    await page.mainFrame().fill('input', 'value', { strict: true });
    const selectedOptions: string[] = await page.selectOption('select', ['a'], { strict: true });
    await page.mainFrame().type('input', 'text', { delay: 1 });
    // @ts-expect-error Strictness must be boolean in packed declarations.
    await page.click('button', { strict: 'true' });
    void selectedOptions;
    const locatorValue: number = await page.locator('button').evaluate((element, value) => value.answer, handle);
    const locatorHandle: import('flashwright').JSHandle<number> = await page.locator('button').evaluateHandle((element, value) => value.answer, handle);
    void selectedInput; void locatorValue; void locatorHandle;
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
    const frameLocator: import('flashwright').FrameLocator = page.frameLocator('iframe').first();
    const frameOwner: import('flashwright').Locator = frameLocator.owner();
    await frameOwner.contentFrame().getByRole('button').click();
    // @ts-expect-error Frame selectors preserve their string parameter.
    page.frameLocator(42);
    const count: number = await locator.count();
    const visible: boolean = await locator.isVisible();
    const options: import('flashwright').ClickOptions = { button: 'left', modifiers: ['ControlOrMeta'], position: { x: 3, y: 4 }, trial: true };
    const pressOptions: import('flashwright').PressOptions = { delay: 5, noWaitAfter: true };
    await locator.press('Enter', pressOptions);
    const keyboard: import('flashwright').Keyboard = page.keyboard;
    await keyboard.press('Enter', { delay: 1 });
    await locator.pressSequentially('typed', { timeout: 100, delay: 1, noWaitAfter: false });
    await keyboard.type('é😃', { delay: 1 });
    const selectTextOptions: import('flashwright').SelectTextOptions = { force: false, timeout: 100 };
    await locator.selectText(selectTextOptions);
    await locator.scrollIntoViewIfNeeded({ timeout: 100 });
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
const corePackagePath = createRequire(join(directory, 'package.json')).resolve('@flashwright/core/package.json');
const runtimeVersionPath = join(dirname(corePackagePath), 'dist/commonjs/runtime-version.cjs');
const originalRuntimeVersion = await readFile(runtimeVersionPath);
await writeFile(runtimeVersionPath, "exports.residentRuntimeSha256 = 'deliberately-incompatible';\n");
await writeFile(join(directory, 'incompatible.mjs'), `import assert from 'node:assert/strict';\nimport { chromium } from 'flashwright';\nawait assert.rejects(chromium.launch(), error => error.name === 'ProtocolError' && (error.message.includes('mismatch') || error.message.includes('does not match')));\n`);
execFileSync('python3', [resolve('tools/watchdog.py'), '--timeout', '15', '--', process.execPath, join(directory, 'incompatible.mjs')], { cwd: directory, env: environment, stdio: 'inherit' });
await writeFile(runtimeVersionPath, originalRuntimeVersion);
// The installation owner runs every dependent check before retiring its packages.
let runtimeIntegrity = null;
if (runtimeArchive) {
  await copyFile('compatibility/m1/runtime-package.mjs', join(directory, 'runtime-package.mjs'));
  const output = execFileSync('python3', [resolve('tools/watchdog.py'), '--timeout', '120', '--report-directory', join(directory, 'runtime-integrity-resources'), '--', process.execPath, 'runtime-package.mjs'], {
    cwd: directory, env: environment, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  await writeFile(join(directory, 'ownership-integrity-output.txt'), output);
  const bytes = await readFile(join(directory, 'runtime-package-checks.json'));
  const result = JSON.parse(bytes);
  assert.equal(result.status, 'passed');
  runtimeIntegrity = { status: result.status, checks: result.checks, reportSha256: createHash('sha256').update(bytes).digest('hex') };
}
const installed = JSON.parse(await readFile(join(directory, 'node_modules/flashwright/package.json'), 'utf8'));
assert.equal(installed.version, '0.0.0');
const reportDirectory = process.env.FLASHWRIGHT_PACKED_REPORT_DIRECTORY ?? 'compatibility/evidence';
await mkdir(reportDirectory, { recursive: true });
const evidence = {
  installation, ...runtimeMetadata, platform: process.platform, architecture: process.arch,
  package: archive.slice(directory.length + 1),
  implementationArchives: Object.fromEntries(await Promise.all(Object.entries(archives).filter(([name]) => name !== 'flashwright').map(async ([name, path]) => [name, { archive: path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }]))), archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
  consumerDirectory: directory, runtimeOverride: environment.FLASHWRIGHT_DRIVER_PATH ?? null, runtimeIntegrity,
  packagedRuntime: runtimePackagePath ? { packageName: runtimePackageName, archiveSha256: createHash('sha256').update(await readFile(runtimeArchive)).digest('hex'), manifest: JSON.parse(await readFile(join(dirname(runtimePackagePath), 'runtime.json'), 'utf8')), installation: 'offline local tarballs, lifecycle scripts disabled, Cargo absent from consumer PATH' } : null,
  driverSha256: createHash('sha256').update(await readFile(selectedDriver)).digest('hex'),
  checks: ['public request wait runtime and declarations', 'Bun packed tarball', 'fresh consumer install', 'ESM runtime', 'CommonJS runtime', 'NodeNext ESM declarations', 'NodeNext CommonJS declarations', 'evaluation generic inference', 'typed page error listeners and event waits in both module formats', 'console live handles, context event waits and fluent typed listeners in both module formats', 'cookie and object/file storage-state round trips with public declarations', 'locator declarations, selection and native text input', 'native trusted click, checkbox input and keyboard shortcuts with public option types', 'default Download event, class/page identity, exact binary path/save/stream bytes, cancellation and deletion in both module formats', 'all nine Download method declarations and boolean acceptDownloads policy', 'owned browser cleanup', 'real HTTP navigation and response body', 'incompatible resident runtime rejected before launch'],
  contentReplacement: 'Page.setContent return, title, DOM, waitUntil and timeout options pass in packed ESM and CommonJS consumers',
  remaining: ['Published platform runtime acquisition', 'pnpm and Yarn consumer matrix', 'package aliases'],
};
const destination = join(reportDirectory, `packed-library-${process.platform}-${process.arch}-${runtimeArtifactLabel}.json`);
await writeFile(destination, JSON.stringify(evidence, null, 2) + '\n');
console.log(`Packed library consumers passed: ${destination}`);

await cleanupPackedConsumer(directory, installation, destination, import.meta.url);
