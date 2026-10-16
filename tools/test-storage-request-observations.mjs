import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPrivateStorageRequests as classify, auditStorageRequests as audit } from './storage-request-observations.mjs';
const origins = { main: 'http://127.0.0.1:41001', child: 'http://127.0.0.1:41002' };
const icon = { method: 'GET', path: '/favicon.ico', referer: origins.main + '/' };
test('only exact reference fallback icons have a separate classification', () => {
  assert.deepEqual(classify('reference', [], origins), []);
  const requests = [icon, { ...icon, child: true, referer: origins.child + '/' }];
  const retained = classify('reference', requests, origins);
  assert.equal(retained.length, 2);
  assert.deepEqual(retained.map(({ classification, ...request }) => request), requests);
  assert.ok(retained.every(request => request.classification === 'reference-private-document-favicon'));
  assert.notEqual(retained[0], requests[0]);
});
test('complete lifetime audit rejects late candidate icons and extra document requests', () => {
  const navigation = { method: 'GET', path: '/login' };
  const expected = ['main GET /login'];
  const bounds = { main: 1, child: 1 };
  assert.deepEqual(audit('flashwright', [navigation], origins, expected, bounds), []);
  assert.throws(() => audit('flashwright', [navigation, icon], origins, expected, bounds));
  assert.throws(() => audit('reference', [navigation, navigation], origins, expected, bounds));
  assert.equal(audit('reference', [navigation, icon], origins, expected, bounds).length, 1);
  assert.throws(() => audit('reference', [navigation, icon, icon], origins, expected, bounds));
});
test('candidate traffic and unrelated reference traffic remain failures', () => {
  assert.deepEqual(classify('flashwright', [], origins), []);
  assert.throws(() => classify('flashwright', [icon], origins));
  for (const request of [
    { ...icon, method: 'POST' }, { ...icon, method: undefined },
    { ...icon, path: '/' }, { ...icon, path: '/favicon.ico?query' },
    { ...icon, referer: origins.main + '/parent' }, { ...icon, referer: '' },
    { ...icon, child: true }, { ...icon, referer: 'https://unrelated.test/' },
  ]) assert.throws(() => classify('reference', [request], origins));
  assert.throws(() => classify('unknown', [], origins));
  assert.throws(() => classify('reference', [icon, icon], origins));
  assert.equal(classify('reference', [icon, icon], origins, 2).length, 2);
  assert.throws(() => classify('reference', [icon], origins, 0));
  assert.throws(() => classify('reference', [{ ...icon, child: 'unknown' }], origins));
});
