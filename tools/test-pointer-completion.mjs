import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../packages/resident-runtime/locator-runtime.js', import.meta.url), 'utf8');
const native = await readFile(new URL('../crates/flashwright-engine/src/pointer.rs', import.meta.url), 'utf8');
const wrapper = native.match(/"functionDeclaration": "(async function\(token\).*?)",/)[1];
const units = text => Array.from(text, character => character.charCodeAt(0));

function fixture() {
  const document = {};
  const element = { ownerDocument: document, isConnected: true };
  const timers = new Map();
  let nextTimer = 0;
  const originalInterceptor = () => {};
  const injected = {
    parseSelector: selector => selector,
    querySelector: () => element,
    elementState: () => ({ matches: false }),
    _hitTargetInterceptor: originalInterceptor,
  };
  const codec = { encode: value => typeof value === 'string' ? { units: units(value) } : { kind: 'undefined' } };
  const runtime = runInNewContext(`${source}; createLocatorRuntime(injected, codec);`, {
    document, injected, codec, createConditionRegistry: () => ({}),
    setTimeout(callback) { const identifier = ++nextTimer; timers.set(identifier, callback); return identifier; },
    clearTimeout(identifier) { timers.delete(identifier); },
  });
  return { runtime, injected, element, originalInterceptor, timers };
}

async function arm(state, settings = {}) {
  assert.equal((await state.runtime.preparePointer(units(JSON.stringify({ selector: 'button' })), Date.now() + 10000,
    'original-attempt', { action: 'click', force: true, ...settings })).status, 'ready');
  assert.equal((await state.runtime.armPointer('original-attempt', null)).status, 'ready');
  assert.equal(state.runtime.pointerElement('original-attempt'), state.element);
  assert.notEqual(state.injected._hitTargetInterceptor, state.originalInterceptor);
}

for (const checked of [false, true]) test(`completion releases the original resident attempt on ${checked ? 'failed checkbox verification' : 'success'}`, async () => {
  const state = fixture();
  await arm(state, checked ? { checked: true } : {});
  const result = await state.runtime.finishPointer('original-attempt');
  assert.equal(result.status, checked ? 'error' : 'success');
  assert.equal(state.runtime.pointerElement('original-attempt'), null);
  assert.equal(state.injected._hitTargetInterceptor, state.originalInterceptor);
  assert.equal(state.timers.size, 0);
  assert.equal((await state.runtime.finishPointer('original-attempt')).status, 'expired');
});

test('a native-event completion is consumed once and restores its hit guard', async () => {
  const state = fixture();
  await arm(state);
  state.injected._hitTargetInterceptor({ isTrusted: true, type: 'pointerup' });
  assert.equal(state.timers.size, 2);
  const completion = [...state.timers.values()].at(-1);
  completion();
  assert.equal(state.injected._hitTargetInterceptor, state.originalInterceptor);
  assert.equal(state.timers.size, 0);
  assert.equal((await state.runtime.finishPointer('original-attempt')).status, 'success');
  assert.equal((await state.runtime.finishPointer('original-attempt')).status, 'expired');
});

for (const mode of ['missing', 'throws', 'rejects']) test(`native completion wrapper serializes ${mode} failures without an escaped exception`, async () => {
  const globals = mode === 'missing' ? {} : { __flashwrightLocatorRuntime: {
    finishPointer() {
      if (mode === 'throws') throw new Error('synchronous failure');
      return Promise.reject(new Error('asynchronous failure'));
    },
  } };
  const complete = runInNewContext(`(${wrapper})`, globals);
  const result = JSON.parse(JSON.stringify(await complete('original-attempt')));
  assert.equal(result.status, 'error');
  assert.equal(String.fromCharCode(...result.message.units), 'Pointer completion runtime failed');
});
