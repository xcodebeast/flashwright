import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const codecSource = readFileSync(new URL('../packages/resident-runtime/serialization.cjs', import.meta.url), 'utf8');
const source = readFileSync(new URL('../packages/resident-runtime/function-wait.cjs', import.meta.url), 'utf8');

/** Retain scheduled callbacks so tests can prove cancellation removes work rather than hiding results. */
function fixture() {
  const frames = new Map();
  const timers = new Map();
  let identifier = 0;
  const context = createContext({ exports: {}, performance: { now: () => 0 },
    requestAnimationFrame: callback => { frames.set(++identifier, callback); return identifier; },
    cancelAnimationFrame: identifier => frames.delete(identifier),
    setTimeout: (callback, interval) => { timers.set(++identifier, { callback, interval }); return identifier; },
    clearTimeout: identifier => timers.delete(identifier),
  });
  runInContext(codecSource + '\n' + source, context);
  const codec = context.exports.createValueCodec();
  let createWaiter;
  const create = (expression, { isFunction = true, argument, polling = null } = {}) =>
    (createWaiter ??= context.exports.createFunctionWaitFactory())(codec, expression, isFunction, codec.encode(argument), [], [], polling);
  const frame = () => { const [identifier, callback] = frames.entries().next().value; frames.delete(identifier); callback(0); };
  const timer = () => { const [identifier, { callback }] = timers.entries().next().value; timers.delete(identifier); callback(); };
  return { context, frames, timers, create, frame, timer };
}

test('controller creation runs no caller code and RAF repeats the whole predicate', async () => {
  const subject = fixture();
  const wait = subject.create('() => { globalThis.visits = (globalThis.visits ?? 0) + 1; return visits === 3 && { answer: 42 }; }');
  assert.equal(subject.context.visits, undefined);
  wait.start();
  assert.equal(subject.context.visits, 1);
  subject.frame(); subject.frame();
  const outcome = await wait.result;
  assert.equal(outcome.outcome, 'success'); assert.equal(outcome.value.answer, 42);
  assert.equal(subject.frames.size, 0); assert.equal(subject.timers.size, 0);
});

test('numeric polling uses the exact interval and abort removes its original callback', async () => {
  const subject = fixture();
  const wait = subject.create('() => false', { polling: 7.5 });
  wait.start();
  assert.equal(subject.frames.size, 0);
  assert.equal([...subject.timers.values()][0].interval, 7.5);
  subject.timer(); wait.abort();
  const outcome = await wait.result;
  assert.equal(outcome.outcome, 'exception'); assert.equal(subject.timers.size, 0);
  wait.start(); assert.equal(subject.timers.size, 0);
});

test('throwing scheduler cancellation preserves the first outcome and disables late callbacks', async () => {
  for (const polling of [null, 7.5]) {
    const subject = fixture();
    runInContext('cancelAnimationFrame = clearTimeout = () => { throw new Error("hostile cancellation"); };', subject.context);
    const wait = subject.create('() => { globalThis.visits = (globalThis.visits ?? 0) + 1; return false; }', { polling });
    wait.start();
    assert.doesNotThrow(() => wait.abort());
    const outcome = await wait.result;
    const failure = JSON.parse(outcome.failure);
    assert.equal(failure.error.code, 'TimeoutError');
    if (polling === null) subject.frame(); else subject.timer();
    wait.abort(); wait.start();
    assert.equal(subject.context.visits, 1);
    assert.equal(await wait.result, outcome);
  }
});

test('a null scheduler handle still receives exact cancellation', async () => {
  for (const polling of [null, 7.5]) {
    const subject = fixture();
    runInContext('requestAnimationFrame = setTimeout = callback => { globalThis.pendingCallback = callback; return null; }; cancelAnimationFrame = clearTimeout = identifier => { globalThis.cancelledIdentifier = identifier; globalThis.pendingCallback = undefined; };', subject.context);
    const wait = subject.create('() => false', { polling });
    wait.start(); wait.abort();
    assert.equal((await wait.result).outcome, 'exception');
    assert.equal(subject.context.cancelledIdentifier, null);
    assert.equal(subject.context.pendingCallback, undefined);
  }
});

test('async false is assimilated once, without another poll', async () => {
  const subject = fixture();
  const wait = subject.create('async () => { globalThis.visits = (globalThis.visits ?? 0) + 1; return false; }');
  wait.start();
  const outcome = await wait.result;
  assert.equal(outcome.value, false); assert.equal(subject.context.visits, 1);
  assert.equal(subject.frames.size, 0);
});

test('never-settling async results remain outwardly abortable', async () => {
  const subject = fixture();
  const wait = subject.create('() => new Promise(() => {})');
  wait.start(); wait.abort();
  assert.equal((await wait.result).outcome, 'exception');
  assert.equal(subject.frames.size, 0); assert.equal(subject.timers.size, 0);
});

test('late async settlement cannot replace cancellation or schedule another predicate', async () => {
  const subject = fixture();
  const wait = subject.create('() => { globalThis.visits = (globalThis.visits ?? 0) + 1; return new Promise(resolve => { globalThis.lateResult = resolve; }); }');
  wait.start(); wait.abort();
  subject.context.lateResult({ late: true });
  await Promise.resolve();
  assert.equal((await wait.result).outcome, 'exception'); assert.equal(subject.context.visits, 1);
});

test('a string expression returning a function retains that function without invoking it', async () => {
  const subject = fixture();
  const wait = subject.create('(() => 42)', { isFunction: false });
  wait.start();
  assert.equal(typeof (await wait.result).value, 'function');
});

test('thrown user errors preserve their execution failure and stop polling', async () => {
  const subject = fixture();
  const wait = subject.create('() => { throw new Error("Execution context was destroyed"); }');
  wait.start();
  const failure = JSON.parse((await wait.result).failure);
  assert.equal(failure.stage, 'execution'); assert.equal(failure.error.code, 'EvaluationError');
  assert.equal(subject.frames.size, 0);
});

test('cached builtins survive later application patches without reading the performance clock', async () => {
  const subject = fixture();
  const first = subject.create('() => true'); first.start(); await first.result;
  runInContext('requestAnimationFrame = () => { throw new Error("patched raf"); }; setTimeout = () => { throw new Error("patched timer"); }; Object.defineProperty(performance, "now", { get() { throw new Error("clock getter"); } });', subject.context);
  for (const polling of [null, 10]) {
    const wait = subject.create('() => false', { polling }); wait.start(); wait.abort();
    assert.equal((await wait.result).outcome, 'exception');
  }
  assert.equal(subject.frames.size, 0); assert.equal(subject.timers.size, 0);
});
