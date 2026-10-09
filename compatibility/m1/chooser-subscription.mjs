import assert from 'node:assert/strict';
import { EngineClient } from '../../packages/flashwright-core/dist/commonjs/client.js';
import { SubscribedEventEmitter } from '../../packages/flashwright-core/dist/commonjs/subscribed-events.js';
import { createRuntimeFixture } from '../../tools/runtime-fixture.mjs';

const transitions = [];
const emitter = new SubscribedEventEmitter({ filechooser: enabled => transitions.push(['filechooser', enabled]), console: enabled => transitions.push(['console', enabled]) });
const callback = () => {};
emitter.once('filechooser', callback); emitter.emit('filechooser', {});
emitter.prependOnceListener('filechooser', callback); emitter.removeAllListeners();
emitter.addListener('console', callback); emitter.on('console', callback); emitter.off('console', callback); emitter.removeListener('console', callback);
assert.deepEqual(transitions, [['filechooser', true], ['filechooser', false], ['filechooser', true], ['filechooser', false], ['console', true], ['console', false]]);

for (const ready of [false, true]) {
  const client = new EngineClient(createRuntimeFixture('compatibility/m1/chooser-subscription-driver.mjs')); client.retain();
  try {
    if (ready) await client.waitForHandshake();
    client.setFileChooserSubscription('page', true);
    const first = client.request('probe.action', { page: 'page', label: 'first' }, 1000);
    const second = client.request('probe.action', { page: 'page', label: 'second' });
    const expired = assert.rejects(client.request('probe.action', { page: 'page', label: 'expired' }, 20), error => error.name === 'TimeoutError');
    await client.request('probe.action', { page: 'sibling', label: 'independent' });
    await expired;
    assert.deepEqual(await client.request('probe.accepted', {}), [['control', 'page', true], ['probe.action', 'sibling', 'independent']]);
    await client.request('probe.release', {});
    await Promise.all([first, second]);
    client.setFileChooserSubscription('page', false);
    client.setFileChooserSubscription('page', true);
    const final = client.request('probe.action', { page: 'page', label: 'final' });
    await client.request('probe.accepted', {});
    await client.request('probe.release', {});
    // Observe acceptance of the second toggle without assuming a microtask count.
    for (let attempt = 0; ; attempt++) {
      const received = await client.request('probe.accepted', {});
      if (received.filter(item => item[0] === 'control').length === 3) break;
      assert(attempt < 20);
    }
    await client.request('page.close', { page: 'page', label: 'close bypasses pending toggle' });
    await client.request('probe.release', {});
    await final;
    assert.deepEqual(await client.request('probe.accepted', {}), [
      ['control', 'page', true], ['probe.action', 'sibling', 'independent'], ['ack', 'page', true],
      ['probe.action', 'page', 'first'], ['probe.action', 'page', 'second'], ['control', 'page', false],
      ['ack', 'page', false], ['control', 'page', true], ['page.close', 'page', 'close bypasses pending toggle'],
      ['ack', 'page', true], ['probe.action', 'page', 'final'],
    ]);
  } finally { await client.release(); }
}
console.log('Chooser registration forms, interception acknowledgement order, sibling progress, finite expiry and closure bypass passed.');
