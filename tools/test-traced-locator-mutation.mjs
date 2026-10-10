import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const source = await readFile(new URL('../packages/resident-runtime/locator-runtime.js', import.meta.url), 'utf8');
const checks = [];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const units = value => Array.from(JSON.stringify(value), character => character.charCodeAt(0));
function fixture() {
  const document = {};
  const original = { ownerDocument: document, isConnected: true };
  const replacement = { ownerDocument: document, isConnected: true };
  let selected = original;
  let queries = 0;
  let stateChecks = 0;
  const mutations = [];
  const injected = {
    parseSelector: selector => selector,
    querySelector: () => { queries++; return selected; },
    checkElementStates: async () => { stateChecks++; return undefined; },
    focusNode: (element, resetSelection) => { mutations.push({ element, resetSelection, action: 'focus' }); return 'done'; },
    fill: (element, value) => { mutations.push({ element, value, action: 'fill' }); return 'done'; },
    selectOptions: (element, values) => { mutations.push({ element, values, action: 'selectOption' }); return values; },
  };
  const codec = { encode: value => typeof value === 'string' ? { kind: 'string', units: [...value].map(character => character.charCodeAt(0)) } : { kind: 'test-value', value }, describeError: error => ({ message: String(error) }) };
  const runtime = runInNewContext(`${source}; createLocatorRuntime(injected, codec);`, { injected, codec, document, createConditionRegistry: () => ({}) });
  return { runtime, original, replacement, mutations, injected, select(value) { selected = value; }, get queries() { return queries; }, get stateChecks() { return stateChecks; } };
}
async function check(name, callback) { await callback(); checks.push(name); }
const report = { status: 'running', checks, scope: 'Controlled resident target ownership; native/browser checks are separate' };
try {
  await check('fill and select resolve once and recheck the retained target before mutation', async () => {
    for (const action of ['fill', 'selectOption']) {
      const state = fixture();
      const request = units({ action, selector: '#target', value: 'value', values: ['value'] });
      const resolved = await state.runtime.resolveActionElement(request, null);
      assert.equal(resolved.value, state.original);
      state.select(state.replacement);
      const result = await state.runtime.runCapturedAction(resolved.value, request, null);
      assert.equal(result.status, 'success');
      assert.equal(state.queries, 1);
      assert.equal(state.stateChecks, 2);
      assert.equal(state.mutations.length, 1);
      assert.equal(state.mutations[0].element, state.original);
    }
  });
  await check('replaced or moved retained target cannot redirect mutation to a new selector match', async () => {
    for (const moved of [false, true]) {
      const state = fixture();
      const request = units({ action: 'fill', selector: '#target', value: 'value' });
      const resolved = await state.runtime.resolveActionElement(request, null);
      state.select(state.replacement);
      if (moved) state.original.ownerDocument = {};
      else state.original.isConnected = false;
      const result = await state.runtime.runCapturedAction(resolved.value, request, null);
      assert.equal(result.status, 'retry');
      assert.equal(state.queries, 1);
      assert.equal(state.mutations.length, 0);
    }
  });
  await check('loss of document or attachment during final readiness prevents mutation', async () => {
    for (const moved of [false, true]) {
      const state = fixture();
      const request = units({ action: 'fill', selector: '#target', value: 'value' });
      const resolved = await state.runtime.resolveActionElement(request, null);
      const entered = deferred(); const release = deferred();
      state.injected.checkElementStates = async () => { entered.resolve(); await release.promise; };
      const work = state.runtime.runCapturedAction(resolved.value, request, null);
      await entered.promise;
      if (moved) state.original.ownerDocument = {};
      else state.original.isConnected = false;
      release.resolve();
      assert.equal((await work).status, 'retry');
      assert.equal(state.mutations.length, 0);
    }
  });
  await check('expired allowance prevents mutation even after successful target resolution', async () => {
    const state = fixture();
    const request = units({ action: 'fill', selector: '#target', value: 'value', force: true });
    const resolved = await state.runtime.resolveActionElement(request, null);
    assert.equal((await state.runtime.runCapturedAction(resolved.value, request, 0)).status, 'expired');
    assert.equal(state.mutations.length, 0);
  });
  await check('keyboard capture preserves non-strict choice and cannot focus a replacement', async () => {
    for (const action of ['press', 'pressSequentially']) {
      const state = fixture();
      const strictness = [];
      const querySelector = state.injected.querySelector;
      state.injected.querySelector = (selector, document, strict) => { strictness.push(strict); return querySelector(selector, document, strict); };
      const request = units({ action, selector: 'input', strict: false });
      const resolved = await state.runtime.resolveActionElement(request, null);
      assert.equal(resolved.value, state.original);
      assert.deepEqual(strictness, [false]);
      assert.equal(state.stateChecks, 0, 'keyboard focus does not inherit pointer actionability');
      state.select(state.replacement);
      assert.equal((await state.runtime.runCapturedAction(resolved.value, request, null)).status, 'success');
      assert.equal(state.mutations[0].element, state.original);
      assert.equal(state.mutations[0].resetSelection, true);
      assert.equal(state.queries, 1, 'captured focus must not resolve a replacement');
      assert.deepEqual(strictness, [false]);
      state.original.isConnected = false;
      assert.equal((await state.runtime.runCapturedAction(resolved.value, request, null)).status, 'retry');
      assert.equal(state.mutations.length, 1);
      state.original.isConnected = true;
      state.original.ownerDocument = {};
      assert.equal((await state.runtime.runCapturedAction(resolved.value, request, null)).status, 'retry');
      state.original.ownerDocument = state.replacement.ownerDocument;
      assert.equal((await state.runtime.runCapturedAction(resolved.value, request, 0)).status, 'expired');
      assert.equal(state.mutations.length, 1);
    }
  });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally { if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
