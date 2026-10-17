import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chromium as reference } from 'playwright';
import { chromium as candidate } from 'flashwright';
import { inspectRemoteAriaTarget } from '../../tools/public-aria-remote-target.mjs';
import { identifyBrowser } from '../../tools/browser-identity.mjs';
import { sourceManifest } from '../../tools/source-manifest.mjs';
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: false });
const hash = b => createHash('sha256').update(b).digest('hex');
const { iso, utils } = createRequire(import.meta.url)('playwright-core/lib/coreBundle');
const report = { schemaVersion: 1, status: 'running', platform: process.platform, architecture: process.arch, runtime: process.versions.bun ? `bun ${process.versions.bun}` : process.version, browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH), scope: 'Selected remote native input, actual cross-process placement, nested geometry, navigation, failure ownership and archived remote input snapshots. A live renderer whose mutation cannot settle may require page disposal under S10; routing retains its gap; init scripts and offline viewer replay have separate conformance gates. No performance claim.', sources: await sourceManifest(), fixtureSha256: hash(await readFile(import.meta.filename)), driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), outcomes: {}, placement: {} };
assert.equal(report.browser.distribution, 'full-chromium');
let port;
const focusRecords = new Map();
const form = `<style>body {margin:11px} button{width:110px;height:36px} input{display:block;margin:5px}</style>
<input id="text" value="before"><textarea id="area"></textarea><div id="edit" contenteditable>before</div><input id="date" type="date">
<select id="select" multiple><option value="r">Red</option><option value="b">Blue</option></select>
<input id="check" type="checkbox"><button id="button">Action</button><button id="second">Second</button>
<script>window.events=[];for(const type of ['beforeinput','input','change','focus','blur','keydown','keyup','click','dblclick','mouseover'])
 document.addEventListener(type,e=>events.push({type,id:e.target.id,trusted:e.isTrusted,x:e.clientX,y:e.clientY}),true);
 window.addEventListener('message',e=>{if(e.data==='focus'){document.querySelector('#text').focus();e.source.postMessage('focused','*')}});
</script>`;
const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://fixture');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (u.pathname === '/focus-event') {
        const key = u.searchParams.get('key');
        focusRecords.set(key, (focusRecords.get(key) ?? 0) + 1);
        res.end('ok');
        return;
    }
    if (u.pathname === '/root')
        res.end(`<style>body{margin:0}#child{position:relative;margin:67px 0 0 93px;width:700px;height:450px;border:2px solid;padding:1px}#overlay{position:fixed;inset:0;z-index:10;background:#aaa8}</style><input id="root"><iframe id="child" name="child" src="http://localhost:${port}/child"></iframe><script>addEventListener('message',e=>{if(e.data==='focus-root'){document.querySelector('#root').focus(); e.source.postMessage('focused','*')}})</script>`);
    else if (u.pathname === '/child')
        res.end(form + `<iframe id="local" name="local" style="margin:30px;border:5px solid;padding:3px;width:400px;height:180px" src="/nested"></iframe><iframe id="remote" name="remote" style="margin:20px;border:7px solid;width:400px;height:180px" src="http://127.0.0.2:${port}/nested"></iframe>`);
    else if (u.pathname === '/nested')
        res.end(form);
    else
        res.end('<h1>Destination</h1>');
});
server.listen(0);
await once(server, 'listening');
port = server.address().port;
const root = `http://127.0.0.1:${port}/root`, child = `http://localhost:${port}/child`;
async function inspectTrace(path, snapshots) {
    const archive = new utils.ZipFile(path);
    try {
        const events = (await archive.read('trace.trace')).toString().trim().split('\n').map(JSON.parse);
        const calls = events.filter(event => event.type === 'before' && ['fill', 'press', 'type', 'selectOption', 'click'].includes(event.method));
        assert.deepEqual(calls.map(call => call.method), ['fill', 'press', 'type', 'selectOption', 'click']);
        const frames = events.filter(event => event.type === 'frame-snapshot').map(event => event.snapshot);
        if (!snapshots) assert.equal(frames.length, 0);
        const storage = new iso.SnapshotStorage(), rendered = new Map();
        for (const frame of frames) {
            const key = `${frame.snapshotName}:${frame.frameId}`;
            assert.ok(!rendered.has(key), 'No duplicate frame phase');
            rendered.set(key, storage.addFrameSnapshot('context', frame, []).render().html);
        }
        for (const [index, call] of calls.entries()) {
            const after = events.filter(event => event.type === 'after' && event.callId === call.callId);
            assert.equal(after.length, 1); assert.ok(!after[0].error);
            if (!snapshots) continue;
            const captured = frames.filter(frame => frame.snapshotName === after[0].afterSnapshot);
            assert.equal(captured.length, 4, 'Root, remote child and both nested documents retain the after phase');
            assert.equal(new Set(captured.map(frame => frame.frameId)).size, 4);
            const remote = captured.filter(frame => frame.frameUrl === child);
            assert.equal(remote.length, 1);
            const html = rendered.get(`${remote[0].snapshotName}:${remote[0].frameId}`);
            const input = html.match(/<input\b[^>]*\bid="text"[^>]*>/i)?.[0];
            assert.ok(input);
            assert.equal(input.match(/__playwright_value_="([^"]*)"/)?.[1], index < 2 ? 'traced' : 'traced!');
        }
        return { actions: calls.length, frameSnapshots: frames.length, verifiedRemoteAfterStates: snapshots ? calls.length : 0 };
    } finally { archive.close(); }
}
async function run(name, chromium) {
    const wire = join(output, name);
    await mkdir(wire);
    process.env.FLASHWRIGHT_PROFILE_BROWSER_PATH = process.env.FLASHWRIGHT_BROWSER_PATH;
    process.env.FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY = wire;
    process.env.FLASHWRIGHT_PROFILE_CLOCK_PORT = '0';
    const browser = await chromium.launch({ executablePath: resolve('tools/frame-placement-proxy.py') });
    const groups = report.outcomes[name] = [];
    const pass = s => { groups.push(s); console.log(name, s); };
    try {
        const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
        context.setDefaultTimeout(2500);
        const page = await context.newPage();
        await page.goto(root);
        const records = async () => { const files = (await readdir(wire)).filter(f => f.endsWith('.jsonl')); assert.equal(files.length, 1); return (await readFile(join(wire, files[0]), 'utf8')).trim().split('\n').map(JSON.parse); };
        report.placement[name] = inspectRemoteAriaTarget(await records(), root, child);
        assert.equal(report.placement[name].placement, 'out-of-process');
        const frame = page.frame('child'), f = page.frameLocator('#child'), text = f.locator('#text');
        await text.fill('héllo 😀');
        assert.equal(await text.inputValue(), 'héllo 😀');
        await text.fill('');
        assert.equal(await text.inputValue(), '');
        await f.locator('#area').fill('line1\nline2');
        assert.equal(await f.locator('#area').inputValue(), 'line1\nline2');
        await f.locator('#edit').fill('editable');
        assert.equal(await f.locator('#edit').textContent(), 'editable');
        await f.locator('#date').fill('2026-10-16');
        assert.equal(await f.locator('#date').inputValue(), '2026-10-16');
        assert.deepEqual(await f.locator('#select').selectOption([{ label: 'Blue' }, { value: 'r' }]), ['r', 'b']);
        await text.focus();
        assert.equal(await frame.evaluate(() => document.activeElement.id), 'text');
        await text.blur();
        assert.notEqual(await frame.evaluate(() => document.activeElement.id), 'text');
        await frame.locator('#text').fill('direct');
        assert.equal(await text.inputValue(), 'direct');
        assert.equal(await frame.evaluate(() => events.filter(e => e.type === 'beforeinput').every(e => e.trusted)), true);
        pass('fill, Unicode, empty, controls, select, focus and direct Frame');
        await text.fill('');
        await text.pressSequentially('Ab😀');
        assert.equal(await text.inputValue(), 'Ab😀');
        await text.press('ControlOrMeta+A');
        await text.press('Backspace');
        assert.equal(await text.inputValue(), '');
        await text.focus();
        await page.keyboard.insertText('native');
        assert.equal(await text.inputValue(), 'native');
        await frame.evaluate(() => document.querySelector('#text').addEventListener('beforeinput', e => e.preventDefault(), { once: true }));
        await text.fill('blocked');
        assert.equal(await text.inputValue(), 'native');
        pass('native typing, editing shortcuts, current focus and canceled beforeinput');
        await text.fill('');
        await frame.evaluate(() => document.querySelector('#text').addEventListener('input', () => parent.postMessage('focus-root', '*'), { once: true }));
        await text.pressSequentially('xyz', { delay: 100 });
        assert.equal(await text.inputValue(), 'x');
        assert.equal(await page.locator('#root').inputValue(), 'yz');
        pass('typing follows application focus into root');
        await f.locator('#button').click();
        await f.locator('#second').dblclick();
        await f.locator('#button').hover();
        await f.locator('#check').check();
        assert.equal(await f.locator('#check').isChecked(), true);
        await f.locator('#check').uncheck();
        assert.equal(await f.locator('#check').isChecked(), false);
        const clicks = await frame.evaluate(() => events.filter(e => e.type === 'click'));
        assert.ok(clicks.filter(e => e.id === 'button').length === 1);
        assert.ok(clicks.every(e => e.trusted));
        await f.locator('#button').click({ position: { x: 8, y: 9 } });
        pass('trusted pointer, explicit position, double-click, hover and checkbox');
        for (const id of ['local', 'remote']) {
            const nested = f.frameLocator('#' + id);
            await nested.locator('#text').fill(id);
            await nested.locator('#button').click();
            const n = page.frame(id);
            assert.equal(await n.locator('#text').inputValue(), id);
            assert.equal(await n.evaluate(() => events.filter(e => e.type === 'click' && e.id === 'button' && e.trusted).length), 1);
        }
        pass('nested local and remote geometry, scrolling and input');
        await page.evaluate(() => { const d = document.createElement('div'); d.id = 'overlay'; document.body.append(d); });
        await assert.rejects(f.locator('#button').click({ timeout: 200 }), e => e.name === 'TimeoutError');
        await page.evaluate(() => document.querySelector('#overlay').remove());
        const before = await frame.evaluate(() => events.filter(e => e.type === 'click' && e.id === 'button').length);
        await f.locator('#button').click({ trial: true });
        assert.equal(await frame.evaluate(() => events.filter(e => e.type === 'click' && e.id === 'button').length), before);
        pass('parent overlay interception and trial avoids input');
        await page.evaluate(() => document.querySelector('#child').style.transform = 'translate(17px, 13px)');
        await f.locator('#button').click();
        await page.evaluate(() => document.querySelector('#child').style.transform = '');
        pass('transformed iframe hit handling');
        await assert.rejects(f.locator('button').click(), /strict mode violation/);
        await assert.rejects(f.locator('#missing').fill('x', { timeout: 80 }), e => e.name === 'TimeoutError');
        pass('strictness and absence deadline');
        await page.evaluate(() => { const old = document.querySelector('#child'); const successor = old.cloneNode(); old.remove(); document.body.append(successor); });
        await f.locator('#text').fill('replacement');
        assert.equal(await f.locator('#text').inputValue(), 'replacement');
        await assert.rejects(frame.locator('#text').fill('stale'));
        pass('lazy replacement and captured frame detachment');
        const returned = page.frame('child');
        await page.evaluate(url => document.querySelector('#child').src = url, `http://127.0.0.1:${port}/nested`);
        await f.locator('#text').fill('local-return');
        await f.locator('#button').click();
        assert.equal(await returned.locator('#text').inputValue(), 'local-return');
        await page.evaluate(url => document.querySelector('#child').src = url, child);
        await f.locator('#text').fill('remote-return');
        await f.locator('#button').click();
        assert.equal(await returned.locator('#text').inputValue(), 'remote-return');
        pass('captured Frame and lazy path follow renderer return for input');
        for (const top of [false, true]) {
            const p = await context.newPage();
            await p.goto(root);
            await p.frame('child').evaluate(({ top, url }) => { document.querySelector('#button').onclick = () => { (top ? window.top : window).location.href = url; }; }, { top, url: `http://127.0.0.1:${port}/destination` });
            await p.frameLocator('#child').locator('#button').click();
            assert.equal(await (top ? p.locator('h1') : p.frameLocator('#child').locator('h1')).textContent(), 'Destination');
            await p.close();
            pass((top ? 'top' : 'child') + ' navigation from remote native click');
        }
        for (const action of ['fill', 'press', 'click']) {
            const isolated = await browser.newContext();
            isolated.setDefaultTimeout(2500);
            const p = await isolated.newPage();
            await p.goto(root);
            const c = p.frame('child');
            await c.locator('#text').count();
            if (action === 'click')
                await c.evaluate(() => { document.querySelector('#button').style.animation = 'slide 0.1s linear infinite alternate'; const style = document.createElement('style'); style.textContent = '@keyframes slide {from{transform:translateX(0)}to{transform:translateX(100px)}}'; document.head.append(style); });
            else
                await c.evaluate(() => { setTimeout(() => { while (true) { } }, 20); });
            if (action !== 'click')
                await new Promise(r => setTimeout(r, 60));
            const loc = c.locator(action === 'click' ? '#button' : '#text');
            const pending = (action === 'fill' ? loc.fill('never', { timeout: 0 }) : action === 'press' ? loc.press('A', { timeout: 0 }) : loc.click({ timeout: 0 })).then(() => ({ success: true }), error => ({ error }));
            await new Promise(r => setTimeout(r, 100));
            await p.evaluate(() => document.querySelector('#child').remove());
            const result = await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(Error('child detachment did not retire ' + action)), 2000))]);
            assert.ok(result.error);
            assert.equal(p.isClosed(), false);
            assert.equal(await p.locator('#root').inputValue(), '');
            await isolated.close();
            pass('unbounded ' + action + ' retires with child while parent survives');
        }
        for (const action of ['fill', 'press']) {
            const isolated = await browser.newContext();
            isolated.setDefaultTimeout(2500);
            const p = await isolated.newPage();
            await p.goto(root);
            const c = p.frame('child');
            const focusKey = name + '-' + action;
            await c.locator('#text').count();
            await c.evaluate(key => document.querySelector('#text').addEventListener('focus', () => { const xhr = new XMLHttpRequest(); xhr.open('GET', '/focus-event?key=' + key, false); xhr.send(); while (true) { } }), focusKey);
            let failure;
            await assert.rejects(action === 'fill' ? c.locator('#text').fill('never', { timeout: 600 }) : c.locator('#text').press('A', { timeout: 600 }), e => { failure = e; return e.name === 'TimeoutError'; });
            (report.uncertainFocus ??= []).push({ engine: name, action, error: failure.details ?? { name: failure.name } });
            assert.equal(focusRecords.get(focusKey), 1);
            if (name === 'candidate' && failure.details?.cleanup === 'resourceDisposed') {
                assert.equal(failure.details.inputDelivery, 'uncertain');
                await p.close();
                const successor = await isolated.newPage();
                await successor.goto(root);
                assert.equal(await successor.frameLocator('#child').locator('#text').inputValue(), 'before');
            }
            else {
                await p.evaluate(() => { const old = document.querySelector('#child'), replacement = old.cloneNode(); old.remove(); document.body.append(replacement); });
                assert.equal(await p.frameLocator('#child').locator('#text').inputValue(), 'before');
            }
            ;
            assert.equal(focusRecords.get(focusKey), 1);
            await isolated.close();
            pass('uncertain ' + action + ' focus is not replayed');
        }
        for (const snapshots of [false, true]) {
            const isolated = await browser.newContext();
            isolated.setDefaultTimeout(2500);
            await isolated.tracing.start({ snapshots, screenshots: false, sources: false });
            const p = await isolated.newPage();
            await p.goto(root);
            const child = p.frameLocator('#child');
            await child.locator('#text').fill('traced');
            await child.locator('#text').press('End');
            await child.locator('#text').pressSequentially('!');
            await child.locator('#select').selectOption('b');
            await child.locator('#button').click();
            assert.equal(await child.locator('#text').inputValue(), 'traced!');
            assert.equal(await p.frame('child').evaluate(() => events.filter(event => event.type === 'click' && event.id === 'button' && event.trusted).length), 1);
            const path = join(output, `${name}-snapshots-${snapshots}.zip`);
            await isolated.tracing.stop({ path });
            (report.traces ??= []).push({ engine: name, snapshots, sha256: hash(await readFile(path)), ...await inspectTrace(path, snapshots) });
            await isolated.close();
        }
        pass('traced target ownership and remote input snapshot states; disabled snapshots remain absent');
        await browser.close();
    }
    finally {
        await browser.close();
    }
}
try {
    await run('reference', reference);
    await run('candidate', candidate);
    assert.deepEqual(report.outcomes.reference, report.outcomes.candidate);
    assert.deepEqual(await sourceManifest(), report.sources);
    assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
    assert.equal(hash(await readFile(report.browser.executablePath)), report.browser.sha256);
    report.status = 'passed';
}
catch (error) {
    report.status = 'failed';
    report.error = String(error.stack);
    throw error;
}
finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
