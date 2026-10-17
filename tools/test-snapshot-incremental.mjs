import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const output = process.argv[2];
await mkdir(output);
const candidate = await readFile(new URL('../packages/resident-runtime/snapshot-runtime.js', import.meta.url), 'utf8');
const base = candidate;
const hash = s => createHash('sha256').update(s).digest('hex');
const report = { status: 'running', baseSha256: hash(base), candidateSha256: hash(candidate), checks: [] };
let browser;
try {
    browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
    const page = await browser.newPage();
    await page.setContent('<!doctype html><style>.scroll{width:150px;height:25px;overflow:auto}.wide{width:600px;height:300px}</style><main id="main"><table>' + Array.from({ length: 40 }, (_, i) => `<tr id="r${i}"><td>row ${i}</td><td title="metadata">value</td></tr>`).join('') + '</table><div id="scroll" class="scroll"><div class="wide">wide</div></div><div id="host"></div><div id="move">move <span>child</span></div><input id="text"><input id="check" type="checkbox"><select><option>A</option><option>B</option></select><div id="pop" popover>popover</div><dialog>dialog</dialog></main>');
    await page.evaluate(`globalThis.baseFactory=(()=>{${base};return createSnapshotCapture})()`);
    await page.evaluate(`globalThis.candidateFactory=(()=>{${candidate};return createSnapshotCapture})()`);
    await page.evaluate(() => { globalThis.owners = [baseFactory({ maximumCacheNodes: 0, maximumCacheSheets: 0 }), candidateFactory()]; });
    let number = 0;
    const history = [new Map(), new Map()];
    function decode(html, records, n) { const table = []; function walk(item) { if (typeof item === 'string') {
        table.push(item);
        return item;
    } if (Array.isArray(item[0])) {
        const [delta, index] = item[0];
        assert(records.has(n - delta), `missing snapshot ${n - delta}`);
        const target = records.get(n - delta)[index];
        assert.notEqual(target, undefined);
        return target;
    } const result = [item[0], item[1], ...item.slice(2).map(walk)]; table.push(result); return result; } return { tree: walk(html), table }; }
    async function capture(label, mutate = '', { commit = true, target = null } = {}) {
        const n = number + 1;
        const results = await page.evaluate(({ label, n, mutate, target }) => { if (mutate)
            (0, eval)(mutate); return owners.map(owner => owner.capture({ token: label, snapshotNumber: n, callId: label, target: target ? document.querySelector(target) : undefined })); }, { label, n, mutate, target });
        const decoded = results.map((r, i) => decode(r.data.html, history[i], n));
        try {
            assert.deepEqual(decoded[0].tree, decoded[1].tree);
            assert.deepEqual(results[0].data.resourceOverrides, results[1].data.resourceOverrides);
            for (const r of results) {
                assert(Buffer.byteLength(JSON.stringify(r.data)) <= r.counters.bytes);
                assert(r.tentativeCache.bytes <= 2097152);
                assert(r.tentativeCache.nodes <= 12500);
            }
        }
        catch (error) {
            await writeFile(output + '/failure.json', JSON.stringify({ label, results, decoded }, null, 2));
            throw error;
        }
        await page.evaluate(({ label, n, commit }) => owners.forEach(owner => commit ? owner.commit(label, n) : owner.discard(label)), { label, n, commit });
        if (commit) {
            number = n;
            decoded.forEach((d, i) => history[i].set(n, d.table));
        }
        report.checks.push({ label, committed: commit, referenceBytes: Buffer.byteLength(JSON.stringify(results[0].data.html)), candidateBytes: Buffer.byteLength(JSON.stringify(results[1].data.html)) });
    }
    await capture('initial');
    await capture('unchanged');
    // Let removal notifications finish before editing: detached descendants are no longer observed.
    await page.evaluate(() => { globalThis.detached = document.querySelector('#move'); detached.remove(); });
    await page.evaluate(() => { detached.querySelector('span').textContent = 'edited while detached'; });
    await page.evaluate(() => document.querySelector('#main').append(detached));
    await capture('detached-subtree-edited-between-tasks');
    await page.evaluate(() => { globalThis.otherDocument = document.implementation.createHTMLDocument(); otherDocument.body.append(detached); });
    await page.evaluate(() => { detached.querySelector('span').textContent = 'edited after adoption'; });
    await page.evaluate(() => document.querySelector('#main').append(detached));
    await capture('adopted-subtree-edited-and-returned');
    await capture('mutation-record-overflow', `for(let i=0;i<520;i++) document.querySelector('#r1').setAttribute('title','record '+i);`);
    await capture('deep-branch-initial', `const container=document.createElement('div');container.id='branches';for(let i=0;i<100;i++){let branch=container;for(let j=0;j<45;j++){const child=document.createElement('div');branch.append(child);branch=child;}branch.id='branch-'+i;branch.textContent='old';}document.body.append(container);`);
    await capture('ancestor-visit-overflow', `for(let i=0;i<100;i++)document.querySelector('#branch-'+i).firstChild.data='new '+i;`);
    await capture('remove-deep-branches', `document.querySelector('#branches').remove();`);
    await capture('same-task-text-and-attributes', `document.querySelector('#r4 td').firstChild.data='méta 😀 \\ud800';document.querySelector('#r8').setAttribute('title','same task');`);
    await capture('insert-remove-reorder', `const t=document.querySelector('tbody');t.append(t.firstChild);document.querySelector('#r6').remove();const p=document.createElement('p');p.textContent='new';document.querySelector('#main').append(p);`);
    await capture('direct-scroll', `document.querySelector('#scroll').scrollTo(35,19);`);
    await capture('cssom-clamp-scroll', `document.styleSheets[0].cssRules[1].style.height='1px';document.styleSheets[0].cssRules[1].style.width='1px';`);
    await capture('target-first', '', { target: '#r9' });
    await capture('target-new-call-id', '', { target: '#r9' });
    await capture('target-moved', '', { target: '#r10' });
    await capture('target-cleared');
    await capture('shadow-attached', `const s=document.querySelector('#host').attachShadow({mode:'open'});s.innerHTML='<span>shadow</span>';const sheet=new CSSStyleSheet();sheet.replaceSync('span{color:red}');s.adoptedStyleSheets=[sheet];`);
    await capture('move-into-shadow', `globalThis.moved=document.querySelector('#move');document.querySelector('#host').shadowRoot.append(moved);`);
    await capture('unobserved-shadow-mutation', `moved.querySelector('span').textContent='changed inside shadow';document.querySelector('#host').shadowRoot.adoptedStyleSheets[0].cssRules[0].style.color='blue';`);
    await capture('move-back-and-change', `document.querySelector('#main').append(moved);moved.setAttribute('title','back');`);
    await capture('live-forms', `document.querySelector('#text').value='property 😀';document.querySelector('#check').checked=true;document.querySelector('select').selectedIndex=1;`);
    await capture('popover-and-dialog', `document.querySelector('#pop').showPopover();document.querySelector('dialog').showModal();`);
    await capture('discard-mutated', `document.querySelector('#r11').setAttribute('title','must survive discard');`, { commit: false });
    await capture('after-discard');
    // Hold a tentative generation across further mutations: committing it must not erase their invalidation.
    await page.evaluate(n => owners.forEach(owner => owner.capture({ token: 'held', snapshotNumber: n })), number + 1);
    await page.evaluate(() => { document.querySelector('#r12').setAttribute('title', 'after pending capture'); owners.forEach(owner => owner.discard('held')); });
    await capture('mutation-after-pending-discard');
    const pendingNumber = number + 1;
    const held = await page.evaluate(n => owners.map(owner => owner.capture({ token: 'pending-commit', snapshotNumber: n })), pendingNumber);
    held.forEach((r, i) => history[i].set(pendingNumber, decode(r.data.html, history[i], pendingNumber).table));
    await page.evaluate(n => { document.querySelector('#r13').title = 'changed after capture'; owners.forEach(owner => owner.commit('pending-commit', n)); }, pendingNumber);
    number = pendingNumber;
    await capture('mutation-after-pending-commit');
    for (const settings of [{ maximumCacheBytes: 0, maximumCacheNodes: 0 }, { maximumCacheBytes: 500, maximumCacheNodes: 8, maximumCacheAttributes: 5 }]) {
        await page.evaluate(settings => { owners.forEach(o => o.retire()); owners = [baseFactory({ ...settings, maximumCacheNodes: 0, maximumCacheSheets: 0 }), candidateFactory(settings)]; }, settings);
        number = 0;
        history.forEach(h => h.clear());
        await capture('bounded-initial-' + JSON.stringify(settings));
        await capture('bounded-unchanged-' + JSON.stringify(settings));
        await capture('bounded-change-' + JSON.stringify(settings), `document.querySelector('#r17').textContent='boundedchanged';`);
    }
    await page.evaluate(() => owners.forEach(o => o.retire()));
    // Observe resource ownership directly in a separate page, without changing application prototypes in product code.
    const lifecycle = await browser.newPage();
    await lifecycle.setContent('<div id="parent"></div>');
    await lifecycle.evaluate(() => {
        const Native = MutationObserver;
        globalThis.observerCounts = { created: 0, active: 0, callbacks: 0 };
        globalThis.MutationObserver = class extends Native {
            constructor(callback) { super(records => { observerCounts.callbacks++; callback(records); }); globalThis.deliverMutations = callback; observerCounts.created++; this.active = false; }
            observe(...args) { super.observe(...args); if (!this.active) {
                this.active = true;
                observerCounts.active++;
            } }
            disconnect() { super.disconnect(); if (this.active) {
                this.active = false;
                observerCounts.active--;
            } }
        };
    });
    await lifecycle.evaluate(`globalThis.factory=(()=>{${candidate};return createSnapshotCapture})()`);
    await lifecycle.evaluate(() => { globalThis.owner = factory(); globalThis.zero = factory({ maximumCacheNodes: 0 }); });
    assert.deepEqual(await lifecycle.evaluate(() => observerCounts), { created: 0, active: 0, callbacks: 0 });
    await lifecycle.evaluate(() => { zero.capture({ token: 'zero', snapshotNumber: 1 }); zero.commit('zero', 1); zero.retire(); });
    assert.equal(await lifecycle.evaluate(() => observerCounts.active), 0);
    await lifecycle.evaluate(() => { const node = document.createElement('div'); node.textContent = 'weak cached child'; document.querySelector('#parent').append(node); globalThis.weakNode = new WeakRef(node); owner.capture({ token: 'weak', snapshotNumber: 1 }); owner.commit('weak', 1); node.remove(); });
    assert.equal(await lifecycle.evaluate(() => observerCounts.active), 1);
    // Chromium may retain removed nodes through stale layout objects until layout is updated.
    await lifecycle.evaluate(() => document.body.offsetHeight);
    const session = await lifecycle.context().newCDPSession(lifecycle);
    await session.send('HeapProfiler.collectGarbage');
    await session.send('HeapProfiler.collectGarbage');
    assert.equal(await lifecycle.evaluate(() => weakNode.deref() === undefined), true, 'cache must not retain a detached application subtree');
    await lifecycle.evaluate(() => owner.reset());
    assert.equal(await lifecycle.evaluate(() => observerCounts.active), 0);
    await lifecycle.evaluate(() => { owner.capture({ token: 'restart', snapshotNumber: 1 }); owner.commit('restart', 1); });
    assert.equal(await lifecycle.evaluate(() => observerCounts.active), 1);
    await lifecycle.evaluate(() => { owner.retire(); owner.retire(); });
    assert.equal(await lifecycle.evaluate(() => observerCounts.active), 0);
    const callbacks = await lifecycle.evaluate(() => observerCounts.callbacks);
    await lifecycle.evaluate(() => document.querySelector('#parent').textContent = 'after retirement');
    assert.equal(await lifecycle.evaluate(() => observerCounts.callbacks), callbacks);
    const removedVisits = await lifecycle.evaluate(() => {
        const empty = factory({ maximumCacheBytes: 0 });
        const snapshot = empty.capture({ token: 'empty', snapshotNumber: 1 });
        empty.commit('empty', 1);
        if (snapshot.tentativeCache.nodes !== 0) throw new Error('Expected no admitted cache nodes');
        let visits = 0;
        const removedNodes = { *[Symbol.iterator]() { for (let index = 0; index < 5000; index++) { visits++; yield document.body; } } };
        deliverMutations([{ target: document.body, removedNodes }]);
        empty.retire();
        return visits;
    });
    assert.ok(removedVisits <= 4096, `Empty caches must still bound removal-list work: ${removedVisits}`);
    report.lifecycle = { lazy: true, zeroCacheObserverFree: true, detachedNodeCollected: true, resetDisconnected: true, resetRestarted: true, retiredDisconnected: true, boundedRemovedNodes: true };
    await lifecycle.close();
    await browser.close();
    browser = null;
    report.status = 'passed';
}
catch (error) {
    report.status = 'failed';
    report.error = error.stack;
    process.exitCode = 1;
}
finally {
    if (browser)
        await browser.close();
    await writeFile(output + '/report.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, error: report.error }));
}
