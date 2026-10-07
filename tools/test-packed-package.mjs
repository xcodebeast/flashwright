import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(resolve('.cache/packed-consumer-'));
const packed = JSON.parse(execFileSync('npm', ['pack', '--workspace', 'packages/flashwright', '--pack-destination', directory, '--json'], { encoding: 'utf8' }));
const archive = join(directory, packed[0].filename);
await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'flashwright-consumer-smoke', private: true, type: 'module', dependencies: { flashwright: `file:${archive}`, '@types/node': '24.10.1' } }, null, 2));
execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: directory, stdio: 'pipe' });
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
  const response = await page.goto('http://127.0.0.1:' + server.address().port);
  assert.equal(response.status(), 200);
  assert.equal(await page.title(), 'Packed consumer');
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
for (const entry of ['consumer.mjs', 'consumer.cjs']) {
  execFileSync('python3', [resolve('tools/watchdog.py'), '--timeout', '60', '--', process.execPath, join(directory, entry)], { cwd: directory, env: environment, stdio: 'inherit' });
}
// Deliberately skew the installed runtime hash: incompatibility must reject before launch.
await writeFile(join(directory, 'node_modules/flashwright/dist/commonjs/runtime-version.cjs'), "exports.residentRuntimeSha256 = 'deliberately-incompatible';\n");
await writeFile(join(directory, 'incompatible.mjs'), `import assert from 'node:assert/strict';\nimport { chromium } from 'flashwright';\nawait assert.rejects(chromium.launch(), error => error.name === 'ProtocolError' && error.message.includes('mismatch'));\n`);
execFileSync('python3', [resolve('tools/watchdog.py'), '--timeout', '15', '--', process.execPath, join(directory, 'incompatible.mjs')], { cwd: directory, env: environment, stdio: 'inherit' });
const installed = JSON.parse(await readFile(join(directory, 'node_modules/flashwright/package.json'), 'utf8'));
assert.equal(installed.version, '0.0.0');
await mkdir('compatibility/evidence', { recursive: true });
const evidence = {
  node: process.version, platform: process.platform, architecture: process.arch,
  package: packed[0].filename, archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
  consumerDirectory: directory, runtimeOverride: environment.FLASHWRIGHT_DRIVER_PATH,
  driverSha256: createHash('sha256').update(await readFile(environment.FLASHWRIGHT_DRIVER_PATH)).digest('hex'),
  checks: ['npm packed tarball', 'fresh consumer install', 'ESM runtime', 'CommonJS runtime', 'NodeNext ESM declarations', 'NodeNext CommonJS declarations', 'evaluation generic inference', 'locator declarations, selection and native text input', 'native trusted click, checkbox input and keyboard shortcuts with public option types', 'owned browser cleanup', 'real HTTP navigation and response body', 'incompatible resident runtime rejected before launch'],
  remaining: ['Published platform runtime acquisition', 'pnpm and Yarn consumer matrix', 'package aliases'],
};
const destination = `compatibility/evidence/packed-library-${process.platform}-${process.arch}-${process.versions.node}.json`;
await writeFile(destination, JSON.stringify(evidence, null, 2) + '\n');
console.log(`Packed library consumers passed: ${destination}`);
