import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Exercise the built host modules; no browser or driver is used.
const { prepareAriaSnapshot, prepareAriaSnapshotArguments } = await import(pathToFileURL(resolve(process.argv[2] ?? 'packages/flashwright-core/dist/commonjs/aria-snapshot.js')));
const helper = await readFile(new URL('../packages/resident-runtime/aria-snapshot.js', import.meta.url), 'utf8');
const units = value => Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));
const checks = [];
function check(name, callback) { callback(); checks.push(name); }
const decode = request => JSON.parse(request.map(unit => String.fromCharCode(unit)).join(''));
check('options preserve omitted, zero, negative and large integer depth', () => {
  for (const depth of [undefined, 0, -1, 1, 1e100]) {
    const result = decode(prepareAriaSnapshot(null, { depth }));
    assert.equal(result.depth, depth); assert.equal(result.mode, 'default');
  }
});
check('invalid primitives and AI fail before any browser owner exists', () => {
  for (const options of [{ depth: 0.5 }, { depth: NaN }, { depth: Infinity }, { depth: new Number(1) }, { boxes: 1 }, { boxes: new Boolean(true) }, { mode: 'other' }, null])
    assert.throws(() => prepareAriaSnapshot(null, options), { name: 'InvalidArgumentError' });
  assert.throws(() => prepareAriaSnapshot(null, { mode: 'ai' }), { name: 'UnsupportedFeatureError' });
});
check('UTF-16 request fidelity and exact serialized request bound', () => {
  const selector = 'text="\ud800\ud83d\ude00"';
  assert.equal(decode(prepareAriaSnapshot(selector, {})).selector, selector);
  const overhead = prepareAriaSnapshot('', {}).length;
  assert.equal(prepareAriaSnapshot('x'.repeat(100000 - overhead), {}).length, 100000);
  assert.throws(() => prepareAriaSnapshot('x'.repeat(100001 - overhead), {}), { name: 'ResourceLimitError' });
});
function fixture() {
  const document = {};
  const element = { ownerDocument: document, isConnected: true };
  document.body = element;
  let snapshot = '- button "Save"';
  let encoded = 0;
  const calls = [];
  const injected = {
    parseSelector: selector => selector,
    querySelector(selector, root, strict) { calls.push({ selector, root, strict }); return element; },
    ariaSnapshot(target, options) { calls.push({ target, options }); return snapshot; },
  };
  const codec = { encode(value) { encoded++; return { kind: 'string', units: units(value) }; } };
  const capture = runInNewContext(`${helper}; (request, deadline) => captureAriaSnapshot(injected, codec, request, deadline)`, { injected, codec, document });
  return { document, element, injected, calls, capture, set snapshot(value) { snapshot = value; }, get encoded() { return encoded; } };
}
check('Page reads body and preserves pinned renderer map side effects', () => {
  const state = fixture();
  const result = state.capture({ selector: null, depth: -1, boxes: true }, null);
  assert.equal(result.status, 'success'); assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].target, state.element);
  assert.deepEqual({ ...state.calls[0].options }, { mode: 'default', depth: -1, boxes: true });
});
check('Locator uses strict target lookup, preserving hidden empty snapshots', () => {
  const state = fixture(); state.snapshot = '';
  assert.equal(state.capture({ selector: '#target' }, null).status, 'success');
  assert.equal(state.calls[0].strict, true); assert.equal(state.calls[0].root, state.document);
  state.injected.querySelector = () => { throw new Error('strict mode violation'); };
  assert.throws(() => state.capture({ selector: '.many' }, null), /strict mode/);
});
check('missing body, missing locator, detached and foreign targets retry', () => {
  const state = fixture(); state.document.body = null;
  assert.equal(state.capture({ selector: null }, null).status, 'retry');
  state.injected.querySelector = () => undefined;
  assert.equal(state.capture({ selector: '#later' }, null).status, 'retry');
  for (const changes of [{ isConnected: false }, { isConnected: true, ownerDocument: {} }]) {
    Object.assign(state.element, changes); state.document.body = state.element;
    assert.equal(state.capture({ selector: null }, null).status, 'retry');
  }
  assert.equal(state.calls.length, 0);
});
check('detachment during capture cannot publish predecessor output', () => {
  const state = fixture(); state.injected.ariaSnapshot = () => { state.element.isConnected = false; return 'stale'; };
  assert.equal(state.capture({ selector: null }, null).status, 'retry');
});
check('expired deadline prevents renderer work', () => {
  const state = fixture(); assert.equal(state.capture({ selector: null }, 0).status, 'expired');
  assert.equal(state.calls.length, 0); assert.equal(state.encoded, 0);
});
check('output boundary is UTF-16, lossless and atomic before encoding', () => {
  const state = fixture(); state.snapshot = '\ud800' + '\ud83d\ude00'.repeat(49999) + 'x';
  const result = state.capture({ selector: null }, null);
  assert.equal(result.status, 'success'); assert.equal(result.value.units.length, 100000);
  assert.equal(result.value.units[0], 0xd800);
  state.snapshot = '\ud83d\ude00'.repeat(50000) + 'x';
  assert.equal(state.capture({ selector: null }, null).status, 'resourceLimit');
  assert.equal(state.encoded, 1, 'oversized output must not reach the codec');
});
// Exercise the actual resident wrapper and the native dispatch declaration together.
// CDP only unwraps the async safely() result when awaitPromise is enabled.
const runtimeSource = await readFile(new URL('../packages/resident-runtime/locator-runtime.js', import.meta.url), 'utf8');
const nativeSource = await readFile(new URL('../crates/flashwright-engine/src/aria_snapshots.rs', import.meta.url), 'utf8');
const declaration = JSON.parse(nativeSource.match(/"functionDeclaration":\s*("[^\n]+?"),/)[1]);
const awaitPromise = /"awaitPromise":\s*true/.test(nativeSource);
const transportState = fixture();
const runtimeContext = {
  injected: transportState.injected,
  codec: { encode: value => ({ kind: 'string', units: units(String(value)) }) },
  document: transportState.document,
  createConditionRegistry: () => ({}),
};
const dispatch = runInNewContext(`${helper}; ${runtimeSource}; globalThis.__flashwrightLocatorRuntime = createLocatorRuntime(injected, codec); (${declaration})`, runtimeContext);
async function transported(request) {
  const pending = dispatch(units(JSON.stringify(request)), null);
  assert.equal(typeof pending.then, 'function', 'the real resident entry returns a Promise');
  // Unawaited Promise remote objects have no by-value status; simulate that CDP boundary.
  return JSON.parse(JSON.stringify(awaitPromise ? await pending : pending));
}
assert.equal((await transported({ selector: null })).status, 'success');
transportState.injected.querySelector = () => { throw new Error('strict mode violation'); };
const strictFailure = await transported({ selector: '.many' });
assert.equal(strictFailure.status, 'error');
assert.match(strictFailure.message.units.map(unit => String.fromCharCode(unit)).join(''), /strict mode violation/);
transportState.snapshot = 'x'.repeat(100001);
assert.equal((await transported({ selector: null })).status, 'resourceLimit');
checks.push('native awaitPromise dispatch resolves actual async wrapper success, error and limit outcomes');
const { instrumentTraceMethods, traceChunkOpened, traceChunkClosed } = await import(pathToFileURL(resolve(process.argv[3] ?? 'packages/flashwright-core/dist/commonjs/trace-hooks.js')));
let ownerReads = 0;
let traceBegins = 0;
let traceCompletions = 0;
let bodyCalls = 0;
class SnapshotOwner {
  async ariaSnapshot(options = {}) { bodyCalls++; return prepareAriaSnapshot(null, options); }
}
const tracing = {
  begin(_className, _method, _title, _owner, _names, _values, capture) {
    traceBegins++; assert.equal(capture, 'filmstrip', 'valid calls retain their selected capture policy'); return {};
  },
  async complete() { traceCompletions++; },
};
instrumentTraceMethods(SnapshotOwner.prototype, 'Frame', () => { ownerReads++; return { tracing }; }, {
  ariaSnapshot: { parameters: ['options'], prepareArguments: prepareAriaSnapshotArguments, capture: 'filmstrip' },
});
const owner = new SnapshotOwner();
for (const active of [false, true]) {
  if (active) traceChunkOpened();
  try {
    for (const options of [{ mode: 'ai' }, { futureOption: true }, { depth: 0.5 }, { boxes: 1 }, { timeout: -1 }, { timeout: NaN }, { timeout: null }]) {
      const pending = owner.ariaSnapshot(options);
      assert.equal(typeof pending.then, 'function', 'prevalidation failures retain Promise API behavior');
      await assert.rejects(pending);
    }
    assert.equal(ownerReads, 0); assert.equal(traceBegins, 0); assert.equal(bodyCalls, 0);
  } finally { if (active) traceChunkClosed(); }
}
traceChunkOpened();
try {
  let getterReads = 0;
  const result = await owner.ariaSnapshot({ get depth() { getterReads++; return -1; }, mode: 'default', boxes: true, timeout: 0 });
  assert.equal(decode(result).depth, -1); assert.equal(getterReads, 1);
  assert.equal(bodyCalls, 1); assert.equal(ownerReads, 1); assert.equal(traceBegins, 1); assert.equal(traceCompletions, 1);
} finally { traceChunkClosed(); }
checks.push('unsupported and invalid options reject before trace ownership; valid calls preserve capture and read getters once');
console.log(JSON.stringify({ status: 'passed', checks, scope: 'Controlled host/resident tests only; no native/browser acceptance' }, null, 2));
