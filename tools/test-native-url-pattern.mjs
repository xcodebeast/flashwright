import assert from 'node:assert/strict';
import { matchesURL, validateURLMatcher } from '../packages/flashwright-core/dist/commonjs/waits.js';

assert.equal(matchesURL('http://example.test/path', '/path', 'http://example.test'), true);
assert.equal(matchesURL('http://example.test/next/42', '**/next/*'), true);
const expression = /example/g;
assert.equal(matchesURL('http://example.test/', expression), true);
assert.equal(matchesURL('http://example.test/', expression), false);
const sentinel = new Error('matcher callback');
assert.throws(() => matchesURL('http://example.test', () => { throw sentinel; }), error => error === sentinel);
assert.equal(matchesURL('not a URL', () => { throw sentinel; }), false);
if (typeof globalThis.URLPattern === 'function') {
  const pattern = new URLPattern({ pathname: '/items/:identifier' });
  validateURLMatcher(pattern);
  assert.equal(matchesURL('https://example.test/items/42', pattern), true);
  assert.equal(matchesURL('https://example.test/other', pattern), false);
  assert.equal(matchesURL('not a URL', pattern), false);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'URLPattern');
  try {
    Object.defineProperty(globalThis, 'URLPattern', { configurable: true, writable: true, value: undefined });
    assert.throws(() => validateURLMatcher(pattern), error => error.name === 'InvalidArgumentError');
  } finally { Object.defineProperty(globalThis, 'URLPattern', original); }
} else {
  assert.throws(() => validateURLMatcher({ test: () => true }), error => error.name === 'InvalidArgumentError');
}
console.log(JSON.stringify({ runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`, nativeURLPattern: typeof globalThis.URLPattern === 'function', status: 'passed' }));
