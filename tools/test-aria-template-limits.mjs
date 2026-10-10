import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Locator } from '../packages/flashwright-core/dist/commonjs/index.js';
import { toMatchAriaSnapshot } from '../packages/flashwright-runner/dist/commonjs/aria-matcher.js';
import { upstreamRequire } from '../packages/flashwright-runner/dist/commonjs/upstream-runtime.js';

// Controlled host validation only: any attempt to acquire a browser owner is a test failure.
const { expectConfig, setExpectConfig } = upstreamRequire('./lib/matchers/expect.js');
const originalConfiguration = expectConfig();
const directory = await mkdtemp(join(tmpdir(), 'flashwright-aria-template-'));
const baseline = join(directory, 'snapshot.aria.yml');
let browserOwnerReads = 0;
const locator = new Locator({ page() { browserOwnerReads++; throw new Error('Oversized templates must not reach browser dispatch'); } }, '#never');
const matcherState = { isNot: false, timeout: 100, promise: '', utils: {} };
const configuration = { testInfo: { _resolveSnapshotPaths() { return { absoluteSnapshotPath: baseline }; } }, ignoreSnapshots: false, updateSnapshots: 'all' };
const rejectsResourceLimit = task => assert.rejects(task, error => error.name === 'ResourceLimitError' && /ARIA template/.test(error.message));
try {
  setExpectConfig(configuration);
  await rejectsResourceLimit(() => toMatchAriaSnapshot.call(matcherState, locator, '- text: a\n'.repeat(1000000)));
  await rejectsResourceLimit(() => toMatchAriaSnapshot.call(matcherState, locator, 'x'.repeat(100001)));
  for (const content of ['x'.repeat(100001), '€'.repeat(100001)]) {
    await writeFile(baseline, content);
    await rejectsResourceLimit(() => toMatchAriaSnapshot.call(matcherState, locator, { name: 'snapshot.aria.yml' }));
    assert.equal(await readFile(baseline, 'utf8'), content, 'Resource failure must preserve the existing baseline even in update-all mode');
  }
  if (process.versions.bun) {
    for (const updateSnapshots of ['all', 'changed', 'missing']) {
      setExpectConfig({ ...configuration, updateSnapshots });
      await assert.rejects(() => toMatchAriaSnapshot.call(matcherState, locator, updateSnapshots === 'missing' ? '' : '- button "Save"'), error => error.name === 'UnsupportedFeatureError' && /Bun inline baseline/.test(error.message));
    }
    console.log('Passed three Bun inline update policy cases: typed unsupported errors before browser dispatch.');
  }
  assert.equal(browserOwnerReads, 0);
  console.log('Passed four oversized ARIA template cases: typed resource errors, no browser dispatch, no baseline mutation.');
} finally {
  setExpectConfig(originalConfiguration);
  await rm(directory, { recursive: true, force: true });
}
