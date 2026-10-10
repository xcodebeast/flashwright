import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { forbidUpstreamBrowserBackend } from '../benchmarks/native-backend-guard.mjs';

test('benchmark guard protects the owned runner without loading a second runner', async () => {
  const upstream = forbidUpstreamBrowserBackend();
  const require = createRequire(import.meta.url);
  const runnerRequire = createRequire(require.resolve('@flashwright/test'));
  const directory = dirname(runnerRequire.resolve('@flashwright/runner/package.json'));
  assert.equal(upstream, require(join(directory, 'dist/upstream/test.js')));
  const { expect } = await import('@flashwright/test');
  expect(42).toBe(42);
  assert.equal(require.cache[require.resolve('flashwright-upstream-runner/test')], undefined);
  for (const browser of [upstream.chromium, upstream.firefox, upstream.webkit]) {
    for (const method of ['launch', 'launchPersistentContext', 'connect', 'connectOverCDP']) {
      await assert.rejects(browser[method](), /Forbidden upstream browser backend entered/);
    }
  }
  await assert.rejects(upstream.request.newContext(), /Forbidden upstream request backend entered/);
});
