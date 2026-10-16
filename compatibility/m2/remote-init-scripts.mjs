import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium as reference } from 'playwright';
import { chromium as candidate } from 'flashwright';
import { inspectRemoteAriaTarget } from '../../tools/public-aria-remote-target.mjs';
import { identifyBrowser } from '../../tools/browser-identity.mjs';
import { sourceManifest } from '../../tools/source-manifest.mjs';

const output = resolve(process.argv[2]);
await mkdir(output, { recursive: false });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { schemaVersion: 1, status: 'running', platform: process.platform, architecture: process.arch,
  runtime: process.versions.bun ? `bun ${process.versions.bun}` : process.version,
  browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH),
  driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), sources: await sourceManifest(),
  scope: 'Context/page init scripts in actual remote renderers, registration, disposal, nested frames and process changes. No performance or release claim.',
  outcomes: {}, placement: {} };
assert.equal(report.browser.distribution, 'full-chromium');
let port;
const application = `<script>window.application = JSON.parse(JSON.stringify(globalThis.markers ?? {}));</script>`;
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture');
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(application + `<div id="ready" data-case="${url.searchParams.get('case') ?? 'initial'}">Ready</div>` +
    (url.pathname === '/root' ? `<iframe id="child" name="child" src="http://localhost:${port}/child"></iframe>` :
      url.pathname === '/child' ? `<iframe name="local" src="/leaf"></iframe><iframe name="nested" src="http://127.0.0.2:${port}/leaf"></iframe>` : ''));
});
server.listen(0); await once(server, 'listening'); port = server.address().port;
const root = `http://127.0.0.1:${port}/root`, child = `http://localhost:${port}/child`;
function seed({ key, value }) {
  globalThis.markers ??= {};
  globalThis.markers[key] = { value, executions: (globalThis.markers[key]?.executions ?? 0) + 1 };
}
const expected = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, executions: 1 }]));
const state = frame => frame.evaluate(() => globalThis.application);
const live = frame => frame.evaluate(() => globalThis.markers ?? {});
async function run(name, chromium) {
  const wire = join(output, name); await mkdir(wire);
  Object.assign(process.env, { FLASHWRIGHT_PROFILE_BROWSER_PATH: process.env.FLASHWRIGHT_BROWSER_PATH,
    FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY: wire, FLASHWRIGHT_PROFILE_CLOCK_PORT: '0' });
  const browser = await chromium.launch({ executablePath: resolve('tools/frame-placement-proxy.py') });
  const groups = report.outcomes[name] = [];
  const pass = message => { groups.push(message); console.log(name, message); };
  try {
    const context = await browser.newContext(); context.setDefaultTimeout(4000);
    const contextScript = await context.addInitScript(seed, { key: 'context', value: 'héllo 😀\uD800' });
    const page = await context.newPage();
    const pageScript = await page.addInitScript(seed, { key: 'page', value: 'scoped' });
    await page.goto(root);
    const files = (await readdir(wire)).filter(file => file.endsWith('.jsonl')); assert.equal(files.length, 1);
    const records = (await readFile(join(wire, files[0]), 'utf8')).trim().split('\n').map(JSON.parse);
    report.placement[name] = inspectRemoteAriaTarget(records, root, child);
    assert.equal(report.placement[name].placement, 'out-of-process');
    const all = expected({ context: 'héllo 😀\uD800', page: 'scoped' });
    for (const frame of page.frames()) assert.deepEqual(await state(frame), all);
    pass('Context and page scripts run exactly once before application code in root, remote and nested documents');

    const sibling = await context.newPage(); await sibling.goto(root + '?sibling');
    for (const frame of sibling.frames()) assert.deepEqual(await state(frame), expected({ context: 'héllo 😀\uD800' }));
    const other = await browser.newContext(), otherPage = await other.newPage(); await otherPage.goto(root + '?isolated');
    for (const frame of otherPage.frames()) assert.deepEqual(await state(frame), {});
    await other.close(); await sibling.close();
    pass('Page and context scopes remain isolated across remote documents');

    const lateContext = await context.addInitScript(seed, { key: 'lateContext', value: 42 });
    const latePage = await page.addInitScript(seed, { key: 'latePage', value: true });
    for (const frame of page.frames()) assert.deepEqual(await live(frame), all);
    pass('Registration in existing remote renderers does not execute retroactively');
    const expanded = expected({ context: 'héllo 😀\uD800', page: 'scoped', lateContext: 42, latePage: true });
    for (const [index, url] of [child, `http://127.0.0.1:${port}/leaf`, child].entries()) {
      await page.evaluate(url => { document.querySelector('#child').src = url; }, url + '?case=' + index);
      await page.frameLocator('#child').locator(`#ready[data-case="${index}"]`).waitFor();
      assert.deepEqual(await state(page.frame('child')), expanded);
    }
    pass('Later scripts survive remote navigation, return to the parent renderer and a new remote renderer');

    await Promise.all([pageScript.dispose(), latePage.dispose()]);
    assert.deepEqual(await live(page.frame('child')), expanded);
    await page.goto(root + '?after-page-disposal');
    for (const frame of page.frames()) assert.deepEqual(await state(frame), expected({ context: 'héllo 😀\uD800', lateContext: 42 }));
    await Promise.all([contextScript.dispose(), lateContext.dispose()]);
    await page.goto(root + '?after-context-disposal');
    for (const frame of page.frames()) assert.deepEqual(await state(frame), {});
    pass('Disposal preserves existing values and removes scripts from all future documents');

    const registrations = await Promise.all(Array.from({ length: 8 }, (_, value) => context.addInitScript(seed, { key: String(value), value })));
    await page.goto(root + '?concurrent');
    const concurrent = expected(Object.fromEntries(Array.from({ length: 8 }, (_, value) => [String(value), value])));
    for (const frame of page.frames()) assert.deepEqual(await state(frame), concurrent);
    const captured = page.frame('child');
    await page.evaluate(url => { const old = document.querySelector('#child'); const fresh = old.cloneNode(); fresh.src = url; old.remove(); document.body.append(fresh); }, child + '?case=replaced');
    await page.frameLocator('#child').locator('#ready[data-case="replaced"]').waitFor();
    assert.equal(captured.isDetached(), true);
    assert.deepEqual(await state(page.frame('child')), concurrent);
    await Promise.all(registrations.map(registration => registration.dispose()));
    await page.goto(root + '?all-disposed');
    for (const frame of page.frames()) assert.deepEqual(await state(frame), {});
    pass('Concurrent registrations and disposal preserve exact-once execution across frame replacement');
    await context.close();
  } finally { await browser.close(); }
}
try {
  await run('playwright', reference); await run('flashwright', candidate);
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.playwright);
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
