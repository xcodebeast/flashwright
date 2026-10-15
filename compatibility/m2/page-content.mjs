import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { chromium as reference } from 'playwright';
import { chromium as candidate } from 'flashwright';
import { runtimeMetadata } from '../../tools/javascript-runtime.mjs';
const selectedEngine = process.argv[2];
const reportPath = process.argv[3];
const require = createRequire(import.meta.url);
const { utils } = require(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'));
assert(reportPath, 'Pass an output report path');
assert(['playwright', 'flashwright'].includes(selectedEngine));
const { expect: selectedExpect } = await import(selectedEngine === 'playwright' ? '@playwright/test' : '@flashwright/test');
const pending = new Map();
const gates = new Map();
const sockets = new Set();
const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://fixture').pathname;
    if (pathname.startsWith('/hold-')) {
        pending.set(pathname, response);
        gates.get(pathname)?.();
        return;
    }
    response.setHeader('content-type', pathname === '/xml' ? 'application/xml' : 'text/html');
    response.end(pathname === '/xml' ? '<root>xml</root>' : '<title>Initial</title><button id="old">old</button>');
});
server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { status: 'running', ...runtimeMetadata, platform: process.platform, architecture: process.arch, referenceVersion: '1.60.0', checks: [] };
async function check(engine, name, work) {
    await work();
    report.checks.push({ engine, name, status: 'passed' });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(engine, name);
}
function observe(path) { return new Promise(resolve => gates.set(path, resolve)); }
function release(path, body = '') { const response = pending.get(path); assert(response, path); response.setHeader('content-type', 'text/javascript'); response.end(body); pending.delete(path); gates.delete(path); }
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
try {
    for (const [engine, chromium, expect] of [[selectedEngine, selectedEngine === 'playwright' ? reference : candidate, selectedExpect]]) {
        const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
        report.browserVersion = browser.version();
        try {
            const context = await browser.newContext();
            context.setDefaultTimeout(3000);
            const page = await context.newPage();
            await page.goto(origin);
            const messages = [];
            page.on('console', message => messages.push(message.text()));
            const handle = await page.evaluateHandle(() => ({ preserved: 42 }));
            await check(engine, 'replacement preserves URL, origin, scripts, doctype and exact UTF16', async () => {
                await page.evaluate(() => { window.counter = 4; localStorage.setItem('key', 'value'); });
                assert.equal(await page.setContent('<!DOCTYPE html><title>New</title><script>window.counter++; console.log("visible")</script><p id="text">é🙂\ud800</p>'), undefined);
                assert.equal(page.url(), origin + '/');
                assert.deepEqual(await page.evaluate(() => ({ counter, stored: localStorage.getItem('key'), doctype: document.doctype.name, text: document.querySelector('#text').textContent })), { counter: 5, stored: 'value', doctype: 'html', text: 'é🙂\ud800' });
                assert.deepEqual(await handle.jsonValue(), { preserved: 42 });
                assert.deepEqual(messages, ['visible']);
            });
            await check(engine, 'written scripts retain user activation', async () => {
                await page.setContent('<script>window.contentActivation=navigator.userActivation.isActive</script>');
                assert.equal(await page.evaluate(() => contentActivation), true);
            });
            await check(engine, 'maximum admitted exact UTF16 markup crosses the control node budget compactly', async () => {
                const text = 'x'.repeat(999992) + '\ud800';
                assert.equal(('<p>' + text + '</p>').length, 1000000);
                await page.setContent('<p>' + text + '</p>');
                assert.deepEqual(await page.evaluate(() => ({ length: document.body.textContent.length, last: document.body.textContent.charCodeAt(document.body.textContent.length - 1) })), { length: text.length, last: 0xd800 });
            });
            await check(engine, 'default load waits for a new external script after a previous load', async () => {
                const path = '/hold-' + engine + '-script';
                const arrived = observe(path);
                let finished = false;
                const replacement = page.setContent(`<script src="${path}"></script><p>loaded</p>`).then(() => finished = true);
                await arrived;
                await delay(30);
                assert.equal(finished, false);
                release(path, 'window.externalLoaded=42;');
                await replacement;
                assert.equal(await page.evaluate(() => externalLoaded), 42);
            });
            await check(engine, 'DOMContentLoaded does not wait for an image but load does', async () => {
                const path = '/hold-' + engine + '-image';
                const arrived = observe(path);
                await page.setContent(`<img src="${path}"><p>parsed</p>`, { waitUntil: 'domcontentloaded' });
                await arrived;
                let finished = false;
                const loaded = page.waitForLoadState('load').then(() => finished = true);
                await delay(30);
                assert.equal(finished, false);
                release(path);
                await loaded;
            });
            await check(engine, 'networkidle resets its 500 ms window on every replacement', async () => {
                for (let iteration = 0; iteration < 2; iteration++) {
                    const started = performance.now();
                    await page.setContent('<p>idle</p>', { waitUntil: 'networkidle' });
                    assert(performance.now() - started >= 450);
                }
            });
            await check(engine, 'old fetch does not remain in the replacement idle scope', async () => {
                const path = '/hold-' + engine + '-fetch';
                const arrived = observe(path);
                await page.evaluate(path => { void fetch(path).catch(() => { }); }, path);
                await arrived;
                await page.setContent('<p>fresh</p>', { waitUntil: 'networkidle', timeout: 1500 });
                release(path);
            });
            await check(engine, 'commit returns before external script completion', async () => {
                const path = '/hold-' + engine + '-commit';
                const arrived = observe(path);
                await page.setContent(`<script src="${path}"></script><p id="committed">committed</p>`, { waitUntil: 'commit' });
                await arrived;
                release(path);
                await page.waitForLoadState('load');
            });
            await check(engine, 'pending resident assertion survives replacement', async () => {
                await page.setContent('<p>before</p>');
                const assertion = expect(page.locator('#arrives')).toHaveText('after', { timeout: 2000 });
                await delay(80);
                await page.setContent('<p id="arrives">after</p>');
                await assertion;
            });
            await check(engine, 'overlapping replacements retain load waiters until outstanding resources finish', async () => {
                const path = '/hold-' + engine + '-superseded';
                const arrived = observe(path);
                let firstFinished = false;
                let secondFinished = false;
                const first = page.setContent(`<img src="${path}"><p>first</p>`).then(() => firstFinished = true, error => error);
                await arrived;
                const second = page.setContent('<p id="second">second</p>').then(() => secondFinished = true, error => error);
                await delay(30);
                assert.equal(firstFinished, false);
                assert.equal(secondFinished, false);
                release(path);
                assert.equal(await first, true);
                assert.equal(await second, true);
                assert.equal(await page.locator('#second').textContent(), 'second');
            });
            await check(engine, 'utility-world write ignores main-world prototype overrides', async () => {
                await page.evaluate(() => { Document.prototype.open = () => { throw new Error('hijacked'); }; Document.prototype.write = () => { throw new Error('hijacked'); }; });
                await page.setContent('<p id="safe">safe</p>');
                assert.equal(await page.locator('#safe').textContent(), 'safe');
            });
            await check(engine, 'replacement detaches child frames and retires their handles', async () => {
                await page.setContent('<iframe srcdoc="<p>child</p>"></iframe>');
                const child = page.frames().find(frame => frame !== page.mainFrame());
                assert(child);
                const childHandle = await child.evaluateHandle(() => ({ child: true }));
                await page.setContent('<p>parent only</p>');
                assert.equal(child.isDetached(), true);
                assert.equal(page.frames().length, 1);
                await assert.rejects(() => childHandle.jsonValue());
                await childHandle.dispose();
            });
            await check(engine, 'replacement inherits the context navigation timeout', async () => {
                const path = '/hold-' + engine + '-inherited';
                const arrived = observe(path);
                context.setDefaultNavigationTimeout(120);
                const started = performance.now();
                const outcome = page.setContent(`<img src="${path}">`).catch(error => error);
                await arrived;
                try {
                    assert.equal((await outcome).name, 'TimeoutError');
                    assert(performance.now() - started < 1500, 'must use navigation timeout rather than the 3000 ms ordinary default');
                } finally {
                    release(path);
                    context.setDefaultNavigationTimeout(3000);
                }
            });
            await check(engine, 'trace records the public call and hides its private console marker', async () => {
                const archive = reportPath + '.trace.zip';
                const html = '<p>traced content</p>';
                await context.tracing.start({ snapshots: true });
                await page.setContent(html);
                await context.tracing.stop({ path: archive });
                const zip = new utils.ZipFile(archive);
                try {
                    const events = [];
                    for (const name of await zip.entries()) {
                        if (!name.endsWith('.trace')) continue;
                        events.push(...(await zip.read(name)).toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
                    }
                    const calls = events.filter(event => event.type === 'before' && event.method === 'setContent');
                    assert.equal(calls.length, 1);
                    assert.equal(calls[0].class, 'Frame');
                    assert.equal(calls[0].params.html, html);
                    const completed = events.find(event => event.type === 'after' && event.callId === calls[0].callId);
                    assert(completed && !completed.error);
                    assert(calls[0].beforeSnapshot);
                    assert(completed.afterSnapshot);
                    for (const snapshotName of [calls[0].beforeSnapshot, completed.afterSnapshot])
                        assert(events.some(event => event.type === 'frame-snapshot' && event.snapshot.snapshotName === snapshotName && event.snapshot.isMainFrame));
                    assert(!events.some(event => event.type === 'console' && JSON.stringify(event).includes('__flashwright_content_')));
                } finally { zip.close(); }
            });
            await check(engine, 'load timeout leaves completed replacement usable', async () => {
                const path = '/hold-' + engine + '-timeout';
                const arrived = observe(path);
                const failure = page.setContent(`<img src="${path}"><p id="survives">survives</p>`, { timeout: 150 }).catch(error => error);
                await arrived;
                assert.equal((await failure).name, 'TimeoutError');
                release(path);
                assert.equal(await page.locator('#survives').textContent(), 'survives');
            });
            if (engine === 'flashwright') {
                await check(engine, 'invalid arguments and oversized content have no browser effect', async () => {
                    await page.setContent('<p id="unchanged">unchanged</p>');
                    for (const arguments_ of [[null], ['changed', { waitUntil: 'invalid' }], ['x'.repeat(1000001)]])
                        await assert.rejects(() => page.setContent(...arguments_));
                    assert.equal(await page.locator('#unchanged').textContent(), 'unchanged');
                });
                await check(engine, 'expired replacement queued behind application JS retires only its page', async () => {
                    const blockedPage = await context.newPage();
                    await blockedPage.locator('body').count();
                    const blocked = blockedPage.evaluate(() => { while (true) { } }).catch(error => error);
                    await delay(50);
                    const error = await blockedPage.setContent('<p>late mutation</p>', { timeout: 120 }).catch(error => error);
                    assert.equal(error.name, 'TimeoutError');
                    if (!blockedPage.isClosed())
                        await blockedPage.waitForEvent('close', { timeout: 5000 });
                    assert(await blocked);
                    assert.equal(await page.locator('#unchanged').textContent(), 'unchanged');
                });
            }
            await handle.dispose();
            await check(engine, 'XML document rejects document.open semantics', async () => {
                await page.goto(origin + '/xml');
                await assert.rejects(() => page.setContent('<p>wrong</p>'));
            });
            await check(engine, 'context close cancels an unbounded load wait', async () => {
                await page.goto(origin);
                const path = '/hold-' + engine + '-close';
                const arrived = observe(path);
                const replacement = page.setContent(`<img src="${path}">`, { timeout: 0 }).then(() => null, error => error);
                await arrived;
                await context.close();
                assert(await replacement);
                release(path);
            });
        }
        finally {
            await browser.close();
        }
    }
    report.status = 'passed';
}
catch (error) {
    report.status = 'failed';
    report.error = error.stack;
    process.exitCode = 1;
    console.error(error);
}
finally {
    for (const socket of sockets)
        socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
