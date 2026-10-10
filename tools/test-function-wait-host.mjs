import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { prepareFunctionWait, prepareFunctionWaitArguments } = require('../packages/flashwright-core/dist/commonjs/function-wait.js');
const { Page, Frame } = require('../packages/flashwright-core/dist/commonjs/index.js');
const { traceChunkOpened, traceChunkClosed } = require('../packages/flashwright-core/dist/commonjs/trace-hooks.js');

test('polling and timeout validation rejects malformed or unsupported options before owners exist', async () => {
  const page = Object.create(Page.prototype);
  const frame = Object.create(Frame.prototype);
  let ownerReads = 0;
  Object.defineProperty(page, 'owner', { get() { ownerReads++; throw new Error('owner must not be read'); } });
  Object.defineProperty(frame, 'owner', { get() { ownerReads++; throw new Error('owner must not be read'); } });
  for (const tracing of [false, true]) {
    if (tracing) traceChunkOpened();
    try {
      for (const target of [page, frame]) {
        for (const options of [{ polling: 0 }, { polling: -1 }, { polling: NaN }, { polling: Infinity }, { polling: 'mutation' }, { polling: new Number(5) }, { timeout: -1 }, { timeout: Infinity }, null]) {
          await assert.rejects(target.waitForFunction(() => true, undefined, options), { name: 'InvalidArgumentError' });
        }
        await assert.rejects(target.waitForFunction(() => true, undefined, { futureOption: true }), { name: 'UnsupportedFeatureError' });
        await assert.rejects(target.waitForFunction(42), { name: 'InvalidArgumentError' });
      }
    } finally { if (tracing) traceChunkClosed(); }
  }
  assert.equal(ownerReads, 0);
});

test('Page-to-Frame preparation reads application options and function source once', () => {
  let pollingReads = 0;
  let timeoutReads = 0;
  let sourceReads = 0;
  const predicate = () => 42;
  predicate.toString = () => { sourceReads++; return '() => 42'; };
  const options = { get polling() { pollingReads++; return 5; }, get timeout() { timeoutReads++; return 0; } };
  const pageArguments = prepareFunctionWaitArguments([predicate, undefined, options]);
  const frameArguments = prepareFunctionWaitArguments(pageArguments);
  const prepared = prepareFunctionWait('frame.waitForFunction', frameArguments[0], frameArguments[2]);
  assert.equal(prepared.polling, 5);
  assert.equal(pollingReads, 1); assert.equal(timeoutReads, 1); assert.equal(sourceReads, 1);
});

test('normalization handles methods without executing predicates and bounds UTF-16 source', () => {
  const subject = { predicate(value) { return value; }, async asyncPredicate(value) { return value; } };
  const decode = value => value.source.map(unit => String.fromCharCode(unit)).join('');
  assert.match(decode(prepareFunctionWait('frame.waitForFunction', subject.predicate, {})), /^\(function predicate/);
  assert.match(decode(prepareFunctionWait('frame.waitForFunction', subject.asyncPredicate, {})), /^\(async function asyncPredicate/);
  const text = '"\ud800\0😃"';
  assert.equal(decode(prepareFunctionWait('frame.waitForFunction', text, {})), text);
  assert.throws(() => prepareFunctionWait('frame.waitForFunction', 'x'.repeat(100001), {}), { name: 'ResourceLimitError' });
  assert.throws(() => prepareFunctionWait('frame.waitForFunction', (() => 42).bind(null), {}), { name: 'InvalidArgumentError' });
});
