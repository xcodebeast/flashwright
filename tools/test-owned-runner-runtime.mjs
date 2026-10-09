import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve, join } from 'node:path';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const owned = resolve('packages/flashwright-runner/dist/upstream');
const ownedRequire = createRequire(join(owned, 'package.json'));
const manifest = JSON.parse(await readFile('compatibility/upstream/runner-runtime-manifest.json', 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const checks = [];
assert.equal(ownedRequire.resolve('playwright'), join(owned, 'index.js'));
assert.equal(ownedRequire.resolve('playwright/test'), join(owned, 'test.js'));
assert.equal(ownedRequire.resolve('playwright-core/package.json'), require.resolve('playwright-core/package.json'));
for (const [name, expected] of Object.entries(manifest.files)) {
  const actual = hash(await readFile(join(owned, name)));
  if (name === 'lib/worker/workerProcessEntry.js') assert.notEqual(actual, expected);
  else assert.equal(actual, expected, name);
}
checks.push('all 61 unmodified files and ordinary owned package self-resolution retain their pinned identities');
const worker = await readFile(join(owned, 'lib/worker/workerProcessEntry.js'), 'utf8');
const start = worker.indexOf('var TestTracing = class {');
const end = worker.indexOf('async function mergeTraceFiles(', start);
assert.ok(start > 0 && end > start);
const hookSource = await readFile(join(owned, 'flashwright-hooks.cjs'), 'utf8');
function fixture() {
  const module = { exports: {} };
  vm.runInNewContext(hookSource, { module, require });
  const hooks = module.exports;
  let writes = 0;
  const PinnedTracing = vm.runInNewContext(`${worker.slice(start, end)}\nTestTracing;`, {
    process: { platform: process.platform }, Date, Buffer, flashwrightTraceHooks: hooks,
    import_path2: { default: path }, import_coreBundle: { getPlaywrightVersion: () => '1.60.0' },
    monotonicTime2: () => performance.now(), version: 8, traceOrdinal: 0,
    SerializedFS: class { mkdir() { writes++; } writeFile() { writes++; } },
  });
  const information = { testId: 'original', retry: 0 };
  const tracing = new PinnedTracing(information, '/owned-artifact-directory');
  return { hooks, tracing, information, writes: () => writes };
}
for (const handled of [undefined, false, true]) {
  const owner = fixture();
  if (handled !== undefined) owner.hooks.installTraceStart(information => { assert.equal(information, owner.information); return handled; });
  await owner.tracing.startIfNeeded({ mode: 'on', live: true });
  assert.equal(owner.writes(), handled === true ? 0 : 2);
}
checks.push('handled startup suppresses live allocation while absent or declined handlers preserve original behavior');
{
  const owner = fixture();
  let calls = 0;
  owner.hooks.installTraceStart(() => { calls++; assert.equal(owner.tracing.traceOptions(), undefined); return true; });
  await owner.tracing.startIfNeeded('off'); assert.equal(calls, 1); assert.equal(owner.writes(), 0);
  assert.throws(() => owner.hooks.installTraceStart(() => true), /duplicate/);
  assert.throws(() => { owner.hooks.onTraceStart = () => false; }, TypeError);
}
checks.push('off policy reaches synchronous ownership once and registration cannot be replaced');
for (const rejected of [false, true]) {
  const owner = fixture();
  let settle;
  const pending = new Promise((resolve, reject) => { settle = () => rejected ? reject(Error('late rejection')) : resolve(false); });
  owner.hooks.installTraceStart(() => pending);
  await assert.rejects(owner.tracing.startIfNeeded({ mode: 'on', live: true }), /ownership synchronously/);
  settle(); await pending.catch(() => {}); await Promise.resolve();
  assert.equal(owner.writes(), 0); assert.equal(owner.tracing._liveTraceFile, undefined);
}
checks.push('invalid asynchronous handlers cannot allocate live output after a late resolution or rejection');
console.log(JSON.stringify({ status: 'passed', checks }));
