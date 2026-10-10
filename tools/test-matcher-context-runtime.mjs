import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile('packages/resident-runtime/locator-runtime.js', 'utf8');
const createRuntime = vm.runInNewContext(`${source}\ncreateLocatorRuntime`, {
  document: {}, createConditionRegistry: () => ({}),
});
let selectedElement = { name: 'original' };
let matches = false;
let snapshot = 'original snapshot';
const capturedElements = [];
const runtime = createRuntime({
  parseSelector: () => ({ parts: [] }),
  querySelector: () => selectedElement,
  _expectCore: async () => { selectedElement = { name: 'replacement' }; return { matches, received: 'observed' }; },
  _ariaSnapshotForExpect: element => { capturedElements.push(element); return snapshot; },
}, { encode: value => value });

async function observe({ includeAriaSnapshot, isNot = false }) {
  selectedElement = { name: 'original' };
  const request = JSON.stringify({ selector: '#target', includeAriaSnapshot });
  const units = Array.from({ length: request.length }, (_, index) => request.charCodeAt(index));
  return runtime.assertion(units, null, 'to.have.text', isNot);
}

const ordinary = await observe({});
assert.equal(ordinary.status, 'observation');
assert.equal(ordinary.ariaSnapshot, undefined);
assert.equal(capturedElements.length, 0, 'ordinary library assertions do not add snapshot work');
matches = true;
assert.equal((await observe({ includeAriaSnapshot: true })).ariaSnapshot, undefined);
assert.equal(capturedElements.length, 0, 'successful runner conditions do not render diagnostics');
matches = false;
assert.equal((await observe({ includeAriaSnapshot: true })).ariaSnapshot, snapshot);
assert.equal(capturedElements.at(-1).name, 'original', 'capture retains the predicate target after lookup changes');
assert.equal((await observe({ includeAriaSnapshot: true, isNot: true })).ariaSnapshot, undefined);
assert.equal(capturedElements.length, 1, 'successful negation does not render diagnostics');
matches = true;
assert.equal((await observe({ includeAriaSnapshot: true, isNot: true })).ariaSnapshot, snapshot);
assert.equal(capturedElements.length, 2);
snapshot = 'x'.repeat(20000);
assert.equal((await observe({ includeAriaSnapshot: true, isNot: true })).ariaSnapshot,
  'x'.repeat(16384) + '\n# Diagnostic snapshot truncated at 16384 UTF-16 units');
snapshot = undefined;
assert.equal((await observe({ includeAriaSnapshot: true, isNot: true })).ariaSnapshot, undefined);
console.log('Matcher diagnostic capture policy, original target and retention bounds passed.');
