import assert from 'node:assert/strict';
import { Tracing } from '../packages/flashwright-core/dist/commonjs/tracing.js';
import { receivedDialog } from '../packages/flashwright-core/dist/commonjs/dialog.js';
import { BrowserContext, Page } from '../packages/flashwright-core/dist/commonjs/index.js';
import { traceChunkOpened, traceChunkClosed, traceCommandMetadata } from '../packages/flashwright-core/dist/commonjs/trace-hooks.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const events = [];
  const commands = [];
  const activity = [];
  const sources = [];
  let fences = 0;
  const client = { async request(method, parameters) { commands.push({ method, parameters, traceCall: traceCommandMetadata() }); } };
  const tracing = new Tracing(client, 'original-context', null);
  const chunk = {
    identifier: 'original-chunk', accepting: true,
    native: { identity: { recording: 'original-recording' } },
    writer: { append: event => events.push(event), referenceSources: stack => sources.push(stack), fail: error => { throw error; } },
    channel: { fence: async () => { fences++; } },
    filmstrip: { activity: page => activity.push(page) },
  };
  tracing.chunk = chunk; tracing.includeSources = true; tracing.includeSnapshots = true; tracing.includeScreenshots = true;
  return { client, tracing, chunk, events, commands, activity, sources, fences: () => fences };
}

let checks = 0;
{
  const state = fixture();
  const call = state.tracing.begin('Dialog', 'accept', 'dialog.accept', { tracing: state.tracing, pageId: 'original-page' }, ['promptText'], ['replacement'], 'metadata-only');
  assert.deepEqual(call.nativeTrace, { context: 'original-context', generation: 'original-chunk' });
  assert.equal(Object.isFrozen(call.nativeTrace), true);
  const completions = [];
  call.runnerAction = { complete: error => completions.push(error) };
  await state.tracing.complete(call, undefined, undefined, false);
  assert.equal(state.fences(), 0); assert.deepEqual(state.commands, []); assert.deepEqual(state.activity, []);
  assert.equal(state.sources.length, 1);
  assert.deepEqual(state.events.map(event => event.type), ['before', 'after']);
  assert.equal(state.events[0].beforeSnapshot, undefined); assert.equal(state.events[1].afterSnapshot, undefined);
  assert.deepEqual(Object.entries(state.events[0].params), [['promptText', 'replacement']]);
  assert.ok(state.events[0].stack.some(frame => frame.file.endsWith('test-dialog-trace-hooks.mjs')));
  assert.deepEqual(completions, [undefined]); assert.equal(state.tracing.calls.size, 0);
  checks++;
}
{
  const state = fixture();
  const call = state.tracing.begin('Frame', 'evaluateExpression', 'page.evaluate', { tracing: state.tracing, pageId: 'original-page' }, [], []);
  await state.tracing.complete(call, 42, undefined, false);
  assert.equal(state.fences(), 1); assert.deepEqual(state.activity, ['original-page', 'original-page']);
  assert.equal(state.commands.length, 1); assert.equal(state.commands[0].method, 'context.trace.snapshot.after');
  assert.equal(call.nativeTrace.recording, 'original-recording');
  assert.equal(state.events[0].beforeSnapshot, `before@${call.identifier}`);
  assert.equal(state.events[1].afterSnapshot, `after@${call.identifier}`);
  checks++;
}
{
  const state = fixture();
  const reply = deferred();
  state.client.request = (method, parameters) => {
    state.commands.push({ method, parameters, traceCall: traceCommandMetadata() });
    return reply.promise;
  };
  const dialog = receivedDialog(null, state.client, { page: 'original-page', dialog: 'original-dialog', dialogJson: JSON.stringify({ type: 'prompt', message: 'message', defaultPrompt: 'default' }) }, () => state.tracing);
  traceChunkOpened();
  try {
    const handling = dialog.accept('replacement');
    assert.equal(dialog.page(), null);
    assert.equal(state.commands.length, 1);
    assert.deepEqual(state.commands[0].traceCall, { context: 'original-context', generation: 'original-chunk' });
    assert.equal(state.commands[0].parameters.page, 'original-page');
    assert.ok(state.events[0].pageId.endsWith('/original-page'));
    const retainedCall = [...state.tracing.calls][0];
    const completion = [];
    retainedCall.runnerAction = { complete: error => completion.push(error) };
    state.chunk.accepting = false;
    const successorEvents = [];
    state.tracing.chunk = { ...state.chunk, identifier: 'successor-chunk', accepting: true, writer: { ...state.chunk.writer, append: event => successorEvents.push(event) } };
    reply.resolve(); await handling;
    assert.deepEqual(successorEvents, []); assert.equal(state.events.length, 1);
    assert.deepEqual(completion, [undefined]); assert.equal(state.tracing.calls.size, 0);
    assert.equal(state.fences(), 0); assert.deepEqual(state.activity, []);
  } finally { traceChunkClosed(); }
  checks++;
}
{
  const state = fixture();
  const original = new Error('original handling failure');
  const call = state.tracing.begin('Dialog', 'dismiss', 'dialog.dismiss', { tracing: state.tracing, pageId: 'original-page' }, [], [], 'metadata-only');
  const completion = [];
  call.runnerAction = { complete: error => completion.push(error) };
  await state.tracing.complete(call, undefined, original, true);
  assert.equal(state.events[1].error.message, original.message);
  assert.deepEqual(completion, [original]); assert.equal(state.fences(), 0); assert.deepEqual(state.commands, []);
  checks++;
}
for (const ownerKind of ['page', 'context']) for (const outcome of ['dialog', 'predicate-error', 'console']) {
  const state = fixture();
  const subscriptions = [];
  state.client.subscribeObject = () => () => {};
  state.client.setDialogSubscription = (kind, identifier, enabled) => subscriptions.push({ kind, identifier, enabled });
  state.client.setConsoleSubscription = () => {};
  const context = new BrowserContext(state.client, 'original-context', {}, null, undefined);
  context.tracingValue = state.tracing;
  const page = new Page(state.client, 'original-page', context, false, { mainFrame: 'original-frame', frames: [], navigationSequence: 0 });
  const owner = ownerKind === 'page' ? page : context;
  const value = outcome === 'console' ? { text: () => 'message' } : receivedDialog(page, state.client, {
    page: 'original-page', dialog: 'original-dialog', dialogJson: JSON.stringify({ type: 'confirm', message: 'waiting for recovery', defaultPrompt: '' }),
  }, () => state.tracing);
  const originalError = new Error('original predicate failure');
  traceChunkOpened();
  try {
    const event = outcome === 'console' ? 'console' : 'dialog';
    const waiting = owner.waitForEvent(event, { predicate: async received => {
      assert.equal(received, value);
      if (outcome === 'predicate-error') throw originalError;
      return true;
    } });
    owner.emit(event, value);
    if (outcome === 'predicate-error') await assert.rejects(waiting, error => error === originalError);
    else assert.equal(await waiting, value);
    await state.tracing.drainCompletions(state.chunk);
    assert.equal(state.events[0].class, ownerKind === 'page' ? 'Page' : 'BrowserContext');
    assert.equal(state.events[0].params.event, event);
    assert.equal(state.events[0].method, 'waitForEvent');
    assert.equal(state.events.length, 2);
    assert.equal(state.tracing.calls.size, 0);
    if (event === 'dialog') {
      assert.equal(state.fences(), 0); assert.deepEqual(state.commands, []); assert.deepEqual(state.activity, []);
      assert.equal(state.events[0].beforeSnapshot, undefined); assert.equal(state.events[1].afterSnapshot, undefined);
      assert.deepEqual(subscriptions.map(subscription => subscription.enabled), [true, false]);
    } else {
      assert.equal(state.fences(), 1); assert.equal(state.activity.length, 2);
      assert.equal(state.events[0].beforeSnapshot, `before@${state.events[0].callId}`);
      assert.equal(state.events[1].afterSnapshot, `after@${state.events[0].callId}`);
      assert.equal(state.commands.length, ownerKind === 'page' ? 1 : 0);
    }
  } finally { traceChunkClosed(); }
  checks++;
}
for (const ownerKind of ['page', 'context']) for (const fails of [false, true]) {
  const state = fixture();
  const gate = deferred();
  state.chunk.channel.fence = () => gate.promise;
  state.client.subscribeObject = () => () => {};
  state.client.setConsoleSubscription = () => {};
  const context = new BrowserContext(state.client, 'original-context', {}, null, undefined);
  context.tracingValue = state.tracing;
  const page = new Page(state.client, 'original-page', context, false, { mainFrame: 'original-frame', frames: [], navigationSequence: 0 });
  const owner = ownerKind === 'page' ? page : context;
  const value = { text: () => 'event needed for recovery' };
  const originalError = new Error('original event predicate failure');
  const completions = [];
  traceChunkOpened();
  try {
    const waiting = owner.waitForEvent('console', { predicate: () => { if (fails) throw originalError; return true; } });
    [...state.tracing.calls][0].runnerAction = { complete: error => completions.push(error) };
    owner.emit('console', value);
    if (fails) await assert.rejects(waiting, error => error === originalError);
    else assert.equal(await waiting, value);
    assert.deepEqual(completions, [fails ? originalError : undefined]);
    originalError.message = 'mutated by the event recipient';
    assert.equal(state.tracing.calls.size, 1); assert.equal(state.chunk.completions.size, 1);
    assert.equal(state.events.length, 1); assert.equal(state.commands.length, 0);
    state.chunk.accepting = false;
    const successorEvents = [];
    state.tracing.chunk = { ...state.chunk, identifier: 'successor-chunk', accepting: true, writer: { ...state.chunk.writer, append: event => successorEvents.push(event) } };
    let drained = false;
    const draining = state.tracing.drainCompletions(state.chunk).then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    gate.resolve(); await draining;
    assert.deepEqual(successorEvents, []); assert.equal(state.events.length, 2);
    assert.equal(state.events[1].error?.message, fails ? 'original event predicate failure' : undefined);
    assert.equal(state.commands.length, ownerKind === 'page' ? 1 : 0);
    assert.equal(state.tracing.calls.size, 0); assert.equal(state.chunk.completions.size, 0);
    assert.deepEqual(completions, [fails ? originalError : undefined]);
  } finally { gate.resolve(); traceChunkClosed(); }
  checks++;
}
console.log(JSON.stringify({ status: 'passed', checks, scope: 'Metadata-only dialog delivery/handling trace custody and zero auxiliary admission; other event waiters retain default trace fences/snapshots.' }));
