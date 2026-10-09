import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { identifyBrowser } from './browser-identity.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { iso } = require('playwright-core/lib/coreBundle');
const output = resolve(process.argv[2]);
const source = await readFile(new URL('../packages/resident-runtime/snapshot-runtime.js', import.meta.url), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const report = { status: 'running', kind: 'isolated renderer candidate, not public/native snapshot support', sourceSha256: hash(source), checks: [], captures: [] };
let browser;
await mkdir(output, { recursive: false });
await writeFile(join(output, 'snapshot-runtime.js'), source);
await writeFile(join(output, 'test-snapshot-runtime.mjs'), await readFile(new URL(import.meta.url)));
const markup = html => html.slice(html.indexOf('</script>') + '</script>'.length);
async function check(name, callback) { await callback(); report.checks.push(name); }
try {
  report.browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
  browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><head><style>.sample {color:rgb(10,20,30)}</style></head><body><p class="sample">initial text</p><input id="text" value="initial"><input id="check" type="checkbox"><select><option>first</option><option>second</option></select><div id="shadow"></div><div id="replace"></div></body></html>');
  await page.evaluate(`${source}; globalThis.snapshotFactory = createSnapshotCapture;`);
  await page.evaluate(() => {
    globalThis.beforeCss = { getter: Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype, 'cssRules').get, replace: CSSStyleSheet.prototype.replace, insertRule: CSSStyleSheet.prototype.insertRule };
    globalThis.snapshotOwner = snapshotFactory();
    const shadow = document.querySelector('#shadow').attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p>shadow text</p>';
    globalThis.retainedSheet = new CSSStyleSheet();
    retainedSheet.replaceSync('p { color: rgb(40, 50, 60); }');
    shadow.adoptedStyleSheets = [retainedSheet];
  });
  const storage = new iso.SnapshotStorage();
  let sequence = 0;
  async function capture(label, { commit = true } = {}) {
    const snapshotNumber = sequence + 1;
    const result = await page.evaluate(({ snapshotNumber, label }) => snapshotOwner.capture({ token: label, snapshotNumber }), { snapshotNumber, label });
    const bytes = Buffer.byteLength(JSON.stringify(result.data));
    assert.ok(bytes + result.counters.overrideCount * 256 <= result.counters.bytes, `${label}: serialization is conservatively charged`);
    assert.ok(result.tentativeCache.bytes <= 2 * 1024 * 1024);
    report.captures.push({ label, bytes, result });
    const snapshot = { ...result.data, frameId: 'frame', pageId: 'page', frameUrl: result.data.url, snapshotName: label, callId: label, timestamp: snapshotNumber, isMainFrame: true };
    const rendered = storage.addFrameSnapshot('context', snapshot, []).render().html;
    if (commit) {
      await page.evaluate(({ label, snapshotNumber }) => snapshotOwner.commit(label, snapshotNumber), { label, snapshotNumber });
      sequence++;
    }
    return { result, rendered };
  }
  await check('capture preserves forms, shadow content and current adopted CSS', async () => {
    const { rendered } = await capture('initial');
    assert.ok(rendered.includes('initial text') && rendered.includes('shadow text'));
    assert.ok(rendered.includes('__playwright_value_="initial"'));
    assert.ok(rendered.includes('40, 50, 60'));
  });
  await check('unchanged snapshots preserve references older than the previous capture', async () => {
    const second = await capture('unchanged-2');
    const third = await capture('unchanged-3');
    assert.deepEqual(second.result.data.html[0][0], 1);
    assert.deepEqual(third.result.data.html[0][0], 2);
    assert.equal(markup(second.rendered), markup(third.rendered));
  });
  await check('attribute and live property changes require no observer invalidation', async () => {
    await page.evaluate(() => {
      document.querySelector('.sample').setAttribute('title', 'changed & exact');
      document.querySelector('#text').value = 'property value';
      document.querySelector('#check').checked = true;
      document.querySelector('select').selectedIndex = 1;
    });
    const { rendered } = await capture('properties');
    assert.ok(rendered.includes('title="changed &amp; exact"'));
    assert.ok(rendered.includes('__playwright_value_="property value"'));
    assert.ok(rendered.includes('__playwright_checked_="true"'));
    assert.match(rendered, /<OPTION[^>]*__playwright_selected_="true"[^>]*>second/);
  });
  await check('detached nodes and sheets reenter through current state', async () => {
    await page.evaluate(() => {
      globalThis.retainedNode = document.querySelector('.sample'); retainedNode.remove();
      document.querySelector('#shadow').shadowRoot.adoptedStyleSheets = [];
      retainedSheet.replaceSync('p { color: rgb(70, 80, 90); }');
      retainedNode.textContent = 'changed while detached';
    });
    const detached = await capture('detached');
    assert.ok(!detached.rendered.includes('changed while detached'));
    await page.evaluate(() => { document.body.append(retainedNode); document.querySelector('#shadow').shadowRoot.adoptedStyleSheets = [retainedSheet]; });
    const { rendered } = await capture('reattached');
    assert.ok(rendered.includes('changed while detached') && rendered.includes('70, 80, 90'));
  });
  await check('asynchronous stylesheet replacement is observed without promise hooks', async () => {
    await page.evaluate(async () => { await retainedSheet.replace('p { color: rgb(100, 110, 120); }'); });
    assert.ok((await capture('async-css')).rendered.includes('100, 110, 120'));
    assert.equal(await page.evaluate(() => beforeCss.getter === Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype, 'cssRules').get && beforeCss.replace === CSSStyleSheet.prototype.replace && beforeCss.insertRule === CSSStyleSheet.prototype.insertRule), true);
  });
  await check('uncommitted capture rejects overlap and stale commit tokens', async () => {
    await page.evaluate(number => snapshotOwner.capture({ token: 'pending', snapshotNumber: number }), sequence + 1);
    await assert.rejects(() => page.evaluate(number => snapshotOwner.capture({ token: 'overlap', snapshotNumber: number }), sequence + 1), /requires commit/);
    await assert.rejects(() => page.evaluate(number => snapshotOwner.commit('pending', number + 1), sequence + 1), /invalid committed snapshot/);
    await assert.rejects(() => page.evaluate(() => snapshotOwner.commit('stale', 1)), /stale capture token/);
    await page.evaluate(() => snapshotOwner.discard('pending'));
    assert.equal((await page.evaluate(() => snapshotOwner.inspect())).tentative, null);
  });
  await check('zero and partial caches change encoding without changing rendered meaning', async () => {
    const normal = (await capture('normal-cache')).rendered;
    for (const configuration of [{ maximumCacheBytes: 0, maximumCacheNodes: 0, maximumCacheSheets: 0 }, { maximumCacheBytes: 128, maximumCacheNodes: 3, maximumCacheAttributes: 2, maximumCacheSheets: 1 }]) {
      const result = await page.evaluate(configuration => {
        const owner = snapshotFactory(configuration);
        const first = owner.capture({ token: 'first', snapshotNumber: 1 }); owner.commit('first', 1);
        const second = owner.capture({ token: 'second', snapshotNumber: 2 }); owner.commit('second', 2);
        return [first, second];
      }, configuration);
      const comparisonStorage = new iso.SnapshotStorage();
      for (const [index, item] of result.entries()) {
        const html = comparisonStorage.addFrameSnapshot('context', { ...item.data, frameId: 'frame', pageId: 'page', frameUrl: item.data.url, timestamp: index, isMainFrame: true }, []).render().html;
        assert.equal(markup(html), markup(normal));
      }
    }
  });
  await check('reset removes predecessor references and retirement prevents further capture', async () => {
    const result = await page.evaluate(() => {
      snapshotOwner.reset();
      const captured = snapshotOwner.capture({ token: 'new-chunk', snapshotNumber: 1 });
      snapshotOwner.commit('new-chunk', 1); snapshotOwner.retire();
      return captured;
    });
    assert.equal(result.data.html[0], 'HTML');
    const freshStorage = new iso.SnapshotStorage();
    assert.ok(freshStorage.addFrameSnapshot('context', { ...result.data, frameId: 'frame', pageId: 'page', frameUrl: result.data.url, timestamp: 1, isMainFrame: true }, []).render().html.includes('100, 110, 120'));
    await assert.rejects(() => page.evaluate(() => snapshotOwner.capture({ token: 'closed', snapshotNumber: 1 })), /retired/);
  });
  await check('application mutation between captures cannot grow cache ownership', async () => {
    const unchanged = await page.evaluate(() => {
      const owner = snapshotFactory();
      owner.capture({ token: 'owned', snapshotNumber: 1 }); owner.commit('owned', 1);
      const before = owner.inspect();
      for (let index = 0; index < 100; index++) {
        const node = document.createElement('span'); node.setAttribute('data-iteration', String(index)); document.body.append(node); node.remove();
        const sheet = new CSSStyleSheet(); sheet.replaceSync('span { color: red; }');
      }
      return { before, after: owner.inspect() };
    });
    assert.deepEqual(unchanged.before, unchanged.after);
  });
  await check('node, depth, attribute, sheet and rule bounds reject one-over', async () => {
    const baseline = await page.evaluate(() => snapshotFactory().capture({ token: 'counts', snapshotNumber: 1 }));
    for (const [limit, counter] of [['maximumNodes', 'nodes'], ['maximumDepth', 'depth'], ['maximumAttributes', 'attributes'], ['maximumSheets', 'sheets'], ['maximumRules', 'rules']]) {
      const maximum = baseline.counters[counter];
      assert.ok(maximum > 0, counter);
      const admitted = await page.evaluate(({ limit, maximum }) => snapshotFactory({ [limit]: maximum }).capture({ token: 'exact-count', snapshotNumber: 1 }), { limit, maximum });
      assert.equal(admitted.counters[counter], maximum);
      await assert.rejects(() => page.evaluate(({ limit, maximum }) => snapshotFactory({ [limit]: maximum - 1 }).capture({ token: 'over-count', snapshotNumber: 1 }), { limit, maximum }), /limit/);
    }
    await assert.rejects(() => page.evaluate(() => snapshotFactory({ maximumNodes: 25001 })), /Invalid snapshot limit/);
  });
  await check('failed capture releases tentative state while retaining the committed predecessor', async () => {
    const result = await page.evaluate(() => {
      const count = snapshotFactory().capture({ token: 'count', snapshotNumber: 1 }).counters.nodes;
      const owner = snapshotFactory({ maximumNodes: count });
      owner.capture({ token: 'committed', snapshotNumber: 1 }); owner.commit('committed', 1);
      const before = owner.inspect();
      const extra = document.createElement('span'); extra.textContent = 'over cap'; document.body.append(extra);
      let message;
      try { owner.capture({ token: 'failed', snapshotNumber: 2 }); } catch (error) { message = error.message; }
      const afterFailure = owner.inspect(); extra.remove();
      const recovered = owner.capture({ token: 'recovered', snapshotNumber: 2 }); owner.commit('recovered', 2);
      return { before, afterFailure, message, recovered };
    });
    assert.match(result.message, /traversal limit/);
    assert.deepEqual(result.before, result.afterFailure);
    assert.deepEqual(result.recovered.data.html[0][0], 1);
  });
  await check('lone UTF-16 values and astral pairs survive the renderer representation exactly', async () => {
    const text = '\ud800x\udfff\u0000\ud83d\ude00';
    const result = await page.evaluate(text => {
      document.querySelector('#replace').textContent = text;
      document.querySelector('#text').value = text;
      return snapshotFactory().capture({ token: 'utf16', snapshotNumber: 1 });
    }, text);
    const serialized = JSON.stringify(result.data);
    assert.ok(Buffer.byteLength(serialized) + result.counters.overrideCount * 256 <= result.counters.bytes);
    const collect = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(collect) : value && typeof value === 'object' ? Object.values(value).flatMap(collect) : [];
    assert.ok(collect(result.data.html).filter(value => value === text).length >= 2);
  });
  await check('exact data admission passes and one-byte-lower admission fails cleanly', async () => {
    const baseline = await page.evaluate(() => snapshotFactory({ maximumCacheBytes: 0 }).capture({ token: 'budget', snapshotNumber: 1 }));
    const exact = await page.evaluate(maximumDataBytes => snapshotFactory({ maximumDataBytes, maximumCacheBytes: 0 }).capture({ token: 'exact', snapshotNumber: 1 }), baseline.counters.bytes);
    assert.equal(exact.counters.bytes, baseline.counters.bytes);
    await assert.rejects(() => page.evaluate(maximumDataBytes => snapshotFactory({ maximumDataBytes, maximumCacheBytes: 0 }).capture({ token: 'over', snapshotNumber: 1 }), baseline.counters.bytes - 1), /byte limit/);
  });
  await check('nested grouping rules are counted before serializing their parent CSS', async () => {
    const result = await page.evaluate(() => {
      const element = document.createElement('style');
      element.textContent = '@media all { .nested-one { color: red } @supports (display: block) { .nested-two { color: blue } } }';
      document.head.append(element);
      try {
        const baseline = snapshotFactory().capture({ token: 'nested', snapshotNumber: 1 });
        const owner = snapshotFactory({ maximumRules: baseline.counters.rules - 1 });
        let message;
        try { owner.capture({ token: 'nested-over', snapshotNumber: 1 }); } catch (error) { message = error.message; }
        return { rules: baseline.counters.rules, cssDepth: baseline.counters.cssDepth, message, state: owner.inspect() };
      } finally { element.remove(); }
    });
    assert.ok(result.rules >= 6);
    assert.equal(result.cssDepth, 3);
    assert.match(result.message, /CSS rule limit/);
    assert.equal(result.state.tentative, null);
  });
  await check('nominal renderer byte ceiling admits exact construction and rejects one more byte', async () => {
    const result = await page.evaluate(() => {
      const target = document.querySelector('#replace');
      const original = target.textContent;
      const text = document.createTextNode(''); target.replaceChildren(text);
      try {
        const maximumDataBytes = 4 * 1024 * 1024 - 64 * 1024;
        const base = snapshotFactory({ maximumCacheBytes: 0 }).capture({ token: 'nominal-base', snapshotNumber: 1 });
        text.data = 'x'.repeat(maximumDataBytes - base.counters.bytes);
        const exact = snapshotFactory({ maximumCacheBytes: 0 }).capture({ token: 'nominal-exact', snapshotNumber: 1 });
        const encodedBytes = new TextEncoder().encode(JSON.stringify(exact.data)).length;
        text.appendData('x');
        const owner = snapshotFactory({ maximumCacheBytes: 0 });
        let message;
        try { owner.capture({ token: 'nominal-over', snapshotNumber: 1 }); } catch (error) { message = error.message; }
        return { maximumDataBytes, reservedBytes: exact.counters.bytes, encodedBytes, message, state: owner.inspect() };
      } finally { target.textContent = original; }
    });
    assert.equal(result.reservedBytes, result.maximumDataBytes);
    assert.ok(result.encodedBytes <= result.maximumDataBytes);
    assert.match(result.message, /byte limit/);
    assert.equal(result.state.tentative, null);
    report.nominalByteBoundary = result;
  });
  await page.close();
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  await browser?.close();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(join(output, 'report.json'));
}
