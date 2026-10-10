import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Page, Locator } = require('../packages/flashwright-core/dist/commonjs/index.js');
const { traceChunkOpened, traceChunkClosed } = require('../packages/flashwright-core/dist/commonjs/trace-hooks.js');
let ownerReads = 0;
const page = Object.create(Page.prototype);
const locator = Object.create(Locator.prototype);
Object.defineProperty(page, 'owner', { configurable: true, get() { ownerReads++; throw new Error('Invalid options must not acquire a trace owner'); } });
Object.defineProperty(locator, 'ownerFrame', { configurable: true, get() { ownerReads++; throw new Error('Invalid options must not acquire a frame'); } });
for (const active of [false, true]) {
  if (active) traceChunkOpened();
  try {
    for (const target of [page, locator]) {
      for (const [options, name] of [[{ mode: 'ai' }, 'UnsupportedFeatureError'], [{ futureOption: true }, 'UnsupportedFeatureError'], [{ boxes: 1 }, 'InvalidArgumentError'], [{ depth: 0.5 }, 'InvalidArgumentError'], [{ timeout: -1 }, 'InvalidArgumentError']]) {
        const pending = target.ariaSnapshot(options);
        assert.equal(typeof pending.then, 'function');
        await assert.rejects(pending, { name });
      }
    }
  } finally { if (active) traceChunkClosed(); }
}
assert.equal(ownerReads, 0);
const calls = [];
let completed = 0;
const tracing = { begin(...arguments_) { calls.push(arguments_); return {}; }, async complete() { completed++; } };
Object.defineProperty(page, 'owner', { value: { tracing } });
page.identifier = 'controlled-page';
const frame = { page: () => page, async runAriaSnapshot(selector, options) { return { selector, options }; } };
page.mainFrame = () => frame;
Object.defineProperty(locator, 'ownerFrame', { value: frame });
locator.selector = '#target';
traceChunkOpened();
try {
  const pageResult = await page.ariaSnapshot({ boxes: true });
  const locatorResult = await locator.ariaSnapshot({ depth: 0 });
  assert.deepEqual(pageResult, { selector: null, options: { boxes: true } });
  assert.deepEqual(locatorResult, { selector: '#target', options: { depth: 0 } });
} finally { traceChunkClosed(); }
assert.deepEqual(calls.map(call => call.slice(0, 3)), [['Frame', 'ariaSnapshot', 'page.ariaSnapshot'], ['Frame', 'ariaSnapshot', 'locator.ariaSnapshot']]);
assert.equal(completed, 2);
for (const call of calls) assert.equal(call[6], 'filmstrip', 'ARIA getters retain filmstrip without DOM snapshot references');
console.log(JSON.stringify({ status: 'passed', checks: 22, scope: 'Packaged Page/Locator invalid-option prevalidation with tracing off/on and valid trace metadata; controlled owners, no browser' }));
