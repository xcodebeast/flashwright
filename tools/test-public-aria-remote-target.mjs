import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectRemoteAriaTarget } from './public-aria-remote-target.mjs';
const metadata = (method, parameters, sessionId = 'parent-session') => ({ kind: 'frameMetadata', method, parameters, sessionId });
const parentUrl = 'http://fixture.test/';
const childUrl = 'data:image/svg+xml,fixture';
const records = () => [
  metadata('Page.frameNavigated', { frame: { id: 'parent', url: parentUrl } }),
  metadata('Page.frameAttached', { frameId: 'child', parentFrameId: 'parent' }),
  metadata('Page.frameDetached', { frameId: 'child', reason: 'swap' }),
  metadata('Target.attachedToTarget', { sessionId: 'child-session', targetInfo: { targetId: 'child', type: 'iframe', url: childUrl, parentFrameId: 'parent' } }),
];
test('proves a live remote target without claiming execution in its child world', () => {
  const proof = inspectRemoteAriaTarget(records(), parentUrl, childUrl);
  assert.equal(proof.placement, 'out-of-process'); assert.equal(proof.childFrameId, 'child');
  assert.equal(proof.childSessionId, 'child-session'); assert.equal(proof.parentSessionId, 'parent-session');
});
for (const [name, event] of [
  ['detached target', metadata('Target.detachedFromTarget', { sessionId: 'child-session' })],
  ['removed frame', metadata('Page.frameDetached', { frameId: 'child', reason: 'remove' })],
  ['removed ancestor', metadata('Page.frameDetached', { frameId: 'parent', reason: 'remove' })],
  ['changed remote URL', metadata('Target.targetInfoChanged', { targetInfo: { targetId: 'child', type: 'iframe', url: 'about:blank' } })],
  ['ambiguous attached sessions', metadata('Target.attachedToTarget', { sessionId: 'other-session', targetInfo: { targetId: 'child', type: 'iframe', url: childUrl } })],
  ['wrong parent', metadata('Target.targetInfoChanged', { targetInfo: { targetId: 'child', type: 'iframe', url: childUrl, parentFrameId: 'unrelated' } })],
]) test(`rejects ${name}`, () => assert.throws(() => inspectRemoteAriaTarget([...records(), event], parentUrl, childUrl)));
test('target metadata alone cannot establish original parent ownership', () => {
  assert.throws(() => inspectRemoteAriaTarget(records().filter(record => record.method !== 'Page.frameAttached'), parentUrl, childUrl));
});

test('discovered target plus process swap proves remote placement without attaching a child session', () => {
  const input = records().filter(record => record.method !== 'Target.attachedToTarget');
  input.push(metadata('Target.targetCreated', { targetInfo: { targetId: 'child', type: 'iframe', url: childUrl } }, null));
  const proof = inspectRemoteAriaTarget(input, parentUrl, childUrl);
  assert.equal(proof.childSessionId, null); assert.equal(proof.discovered, true);
  assert.throws(() => inspectRemoteAriaTarget([...input, metadata('Target.targetDestroyed', { targetId: 'child' }, null)], parentUrl, childUrl));
  assert.throws(() => inspectRemoteAriaTarget(input.filter(record => record.method !== 'Page.frameDetached'), parentUrl, childUrl));
});
