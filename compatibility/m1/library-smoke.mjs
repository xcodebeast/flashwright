import assert from 'node:assert/strict';
import { chromium, firefox, webkit, request, UnsupportedFeatureError, InvalidArgumentError, TargetClosedError, EvaluationError, ResourceLimitError } from 'flashwright';
import { verifyEvaluationContexts } from './evaluation-context.mjs';

await assert.rejects(firefox.launch(), UnsupportedFeatureError);
await assert.rejects(webkit.launch(), UnsupportedFeatureError);
await assert.rejects(request.newContext(), UnsupportedFeatureError);
await assert.rejects(chromium.launch({ unknownOption: true }), UnsupportedFeatureError);
await assert.rejects(chromium.launch({ headless: 'yes' }), InvalidArgumentError);

const browser = await chromium.launch();
try {
  assert.equal(browser.version(), '148.0.7778.96');
  const contexts = await Promise.all([browser.newContext(), browser.newContext({ viewport: { width: 640, height: 480 } })]);
  assert.equal(browser.contexts().length, contexts.length);
  assert(contexts.every(context => browser.contexts().includes(context)), "all concurrently created contexts retain their public identity");
  const [first, second] = await Promise.all(contexts.map(context => context.newPage()));
  assert.equal(first.context(), contexts[0]);
  assert.equal(contexts[0].browser(), browser);
  assert.deepEqual(contexts[0].pages(), [first]);
  assert.deepEqual(second.viewportSize(), { width: 640, height: 480 });
  assert.equal(await second.evaluate(() => window.innerWidth), 640);
  await first.evaluate(() => { globalThis.isolatedValue = 'first page only'; });
  assert.equal(await second.evaluate(() => globalThis.isolatedValue), undefined);
  assert.equal(await first.evaluate('6 * 7'), 42);
  const values = [undefined, null, false, true, NaN, Infinity, -Infinity, -0, 2 ** 53 - 1, 123456789012345678901234567890n, 'nul\0 unicode😃 lone\ud800\udfff', [1, undefined, 'two'], { nested: { value: null } }, new Date('2024-01-02T03:04:05Z'), /hello\sworld/giu];
  for (const value of values) assert.deepEqual(await first.evaluate(value => value, value), value);
  const cyclic = { name: 'cycle' };
  cyclic.self = cyclic;
  const cycleResult = await first.evaluate(value => value, cyclic);
  assert.equal(cycleResult.self, cycleResult);
  const objectWithPrototypeKey = JSON.parse('{"__proto__":{"polluted":true}}');
  const prototypeResult = await first.evaluate(value => value, objectWithPrototypeKey);
  assert.equal(Object.getPrototypeOf(prototypeResult), Object.prototype);
  assert.equal(Object.hasOwn(prototypeResult, '__proto__'), true);
  assert.equal({}.polluted, undefined);
  await assert.rejects(first.evaluate(() => { throw new Error('evaluation failure'); }), /evaluation failure/);
  await assert.rejects(first.evaluate(() => { throw new Error('lone\ud800'); }), error => error.message.includes('lone\ud800'));
  for (const message of ['UnsupportedFeatureError: user exception', 'ResourceLimitError: user exception', 'ProtocolError: user exception']) {
    await assert.rejects(first.evaluate(message => { throw new Error(message); }, message), error => {
      assert(error instanceof EvaluationError);
      assert.ok(error.message.includes(message));
      assert.equal(error.details.diagnostics.stage, 'execution');
      return true;
    });
  }
  await assert.rejects(first.evaluate(() => { throw 'large failure '.repeat(10000); }), error => {
    assert(error instanceof EvaluationError);
    assert.equal(error.details.messageUtf16.length, 8192);
    assert.equal(error.details.diagnostics.messageTruncated, true);
    return true;
  });
  await assert.rejects(first.evaluate(() => { throw { get stack() { throw new Error('description failed'); } }; }), error => {
    assert(error instanceof EvaluationError);
    assert.match(error.message, /description could not be read/);
    return true;
  });
  await assert.rejects(first.evaluate(() => ({ get value() { throw Object.assign(new Error('result getter failed'), { name: 'UnsupportedFeatureError', code: 'ResourceLimitError' }); } })), error => {
    assert(error instanceof EvaluationError);
    assert.match(error.message, /result getter failed/);
    assert.equal(error.details.diagnostics.stage, 'resultSerialization');
    return true;
  });
  await first.evaluate(() => { globalThis.argumentWasAccepted = false; });
  await assert.rejects(first.evaluate(() => { globalThis.argumentWasAccepted = true; }, {
    get value() { throw Object.assign(new Error('argument getter failed'), { name: 'UnsupportedFeatureError', code: 'ResourceLimitError' }); },
  }), error => {
    assert(error instanceof EvaluationError);
    assert.match(error.message, /argument getter failed/);
    assert.equal(error.details.diagnostics.stage, 'argumentSerialization');
    return true;
  });
  await assert.rejects(first.evaluate(() => { globalThis.argumentWasAccepted = true; }, 'x'.repeat(100001)), ResourceLimitError);
  assert.equal(await first.evaluate(() => argumentWasAccepted), false);
  await assert.rejects(first.evaluate(() => 'x'.repeat(100001)), error => {
    assert(error instanceof ResourceLimitError);
    assert.equal(error.details.diagnostics.stage, 'resultSerialization');
    return true;
  });
  await assert.rejects(first.evaluate(() => new Map()), UnsupportedFeatureError);
  await assert.rejects(first.evaluate(value => value, new Map()), UnsupportedFeatureError);
  await first.evaluate(() => {
    globalThis.originalErrorConstructor = Error;
    globalThis.Error = class extends originalErrorConstructor {
      constructor(...arguments_) { super(...arguments_); globalThis.retainedCodecError = this; }
    };
  });
  try {
    await assert.rejects(first.evaluate(() => new Map()), UnsupportedFeatureError);
    await assert.rejects(first.evaluate(() => ({ get value() { throw retainedCodecError; } })), error => {
      assert(error instanceof EvaluationError);
      assert.equal(error.details.diagnostics.stage, 'resultSerialization');
      return true;
    });
  } finally {
    await first.evaluate(() => {
      globalThis.Error = originalErrorConstructor;
      delete globalThis.originalErrorConstructor;
      delete globalThis.retainedCodecError;
    });
  }
  await first.evaluate(() => console.log('lone\ud800'));
  assert.equal(await first.evaluate(() => 42), 42);
  const completionOrder = [];
  const delayed = first.evaluate(() => new Promise(resolve => setTimeout(() => resolve('delayed'), 100))).then(value => { completionOrder.push(value); });
  const immediate = second.evaluate(() => 'immediate').then(value => { completionOrder.push(value); });
  await Promise.all([delayed, immediate]);
  assert.deepEqual(completionOrder, ['immediate', 'delayed']);
  const concurrent = await Promise.all(Array.from({ length: 32 }, (_, index) => second.evaluate(value => value * 2, index)));
  assert.deepEqual(concurrent, Array.from({ length: 32 }, (_, index) => index * 2));
  let closeEvents = 0;
  first.on('close', () => closeEvents++);
  await Promise.all([first.close(), first.close()]);
  assert.equal(closeEvents, 1);
  assert(first.isClosed());
  await assert.rejects(first.evaluate(() => 1), TargetClosedError);
  assert.deepEqual(contexts[0].pages(), []);
  await contexts[0].close();
  assert.deepEqual(browser.contexts(), [contexts[1]]);
  const convenience = await browser.newPage();
  assert.equal(browser.contexts().length, 2);
  await convenience.close();
  assert.equal(browser.contexts().length, 1);
} finally { await browser.close(); }
assert.equal(browser.isConnected(), false);
assert.deepEqual(browser.contexts(), []);
await browser.close();
const [sharedFirst, sharedSecond] = await Promise.all([chromium.launch(), chromium.launch()]);
await sharedFirst.close();
try {
  const page = await sharedSecond.newPage();
  assert.equal(await page.evaluate(() => 'still alive'), 'still alive');
} finally { await sharedSecond.close(); }
await verifyEvaluationContexts(chromium);
console.log('Real Chromium library smoke passed: identity, isolation, value graph, concurrent replies and cleanup.');
