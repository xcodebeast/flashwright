import assert from 'node:assert/strict';
import test from 'node:test';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createHttpFixture } from './http-fixture.mjs';
import { requireVerifiedBrowser } from './browser-identity.mjs';
import { quantile, summarize, comparePaired } from '../benchmarks/statistics.mjs';
import { launchArguments } from '../benchmarks/paired-contract.mjs';
import { verifyResidentLoadInvocation } from './verify-resident-load.mjs';
import { verifyDriverComparisonCore } from './driver-comparison-contract.mjs';
import { readEngineConfiguration } from './engine-configuration.mjs';

test('readiness experiments cannot reuse the default engine verification contract', () => {
  const defaults = { residentAssertions: true, conditionInstrumentation: false };
  assert.deepEqual(readEngineConfiguration({}), defaults);
  assert.deepEqual(readEngineConfiguration({ FLASHWRIGHT_EXPERIMENT_POINTER_READINESS: '0' }), defaults);
  assert.deepEqual(readEngineConfiguration({ FLASHWRIGHT_EXPERIMENT_POINTER_READINESS: '1' }), { ...defaults, pointerReadiness: true });
});

test('driver comparisons require identical execution contracts across independently verified backends', () => {
  const browser = { executablePath: '/browser', sha256: 'browser-hash', version: '148.0.7778.96', distribution: 'chromium-headless-shell' };
  const sources = {
    'packages/flashwright-core/src/index.ts': 'adapter', 'benchmarks/workloads/index.mjs': 'workload',
    'benchmarks/sample.mjs': 'sample', 'benchmarks/execute-sample.mjs': 'execution',
    'benchmarks/configurations/baseline.json': 'configuration', 'benchmarks/statistics.mjs': 'statistics',
    'tools/watchdog.py': 'resources', 'tools/engine-configuration.mjs': 'mode',
    'crates/flashwright-protocol/src/messages.rs': 'protocol',
    'crates/flashwright-browser/src/chromium-launch-policy.json': 'flags',
    'crates/flashwright-engine/src/lib.rs': 'old-backend',
  };
  const report = { status: 'passed', sourceChangedDuringVerification: false, browserChangedDuringVerification: false,
    browser, node: 'v24.15.0', platform: 'darwin', architecture: 'arm64', driverSha256: 'reference-driver',
    engineConfiguration: { residentAssertions: true, conditionInstrumentation: false }, sources,
    checks: Array.from({ length: 35 }, () => ({ code: 0 })),
  };
  const metadata = { browser, node: report.node, platform: report.platform, architecture: report.architecture,
    engineConfiguration: report.engineConfiguration,
    drivers: { reference: { sha256: 'reference-driver' }, candidate: { sha256: 'candidate-driver' } },
    sources: { ...sources, 'crates/flashwright-engine/src/lib.rs': 'new-backend', 'benchmarks/compare-drivers.mjs': 'new-harness' },
  };
  verifyDriverComparisonCore(report, metadata, 'reference');
  assert.throws(() => verifyDriverComparisonCore({ ...report, node: null, runtime: { name: 'bun', version: '1.4.2' } }, metadata, 'reference'));
  assert.throws(() => verifyDriverComparisonCore({ ...report, node: null }, { ...metadata, node: null }, 'reference'));
  verifyDriverComparisonCore({ ...report, sources: metadata.sources, driverSha256: 'candidate-driver' }, metadata, 'candidate');
  for (const name of Object.keys(sources).filter(name => name !== 'crates/flashwright-engine/src/lib.rs')) {
    assert.throws(() => verifyDriverComparisonCore(report, { ...metadata, sources: { ...metadata.sources, [name]: 'changed' } }, 'reference'), /changed shared execution source/);
  }
  assert.throws(() => verifyDriverComparisonCore(report, { ...metadata, sources: { ...metadata.sources, 'benchmarks/workloads/new-helper.mjs': 'unverified' } }, 'reference'), /Missing verified execution source/);
  for (const alteration of [
    { status: 'failed' }, { sourceChangedDuringVerification: true }, { driverSha256: 'different-driver' },
    { engineConfiguration: { residentAssertions: false, conditionInstrumentation: false } }, { checks: [{ code: 0 }] },
    { browser: { ...browser, sha256: 'another-browser' } },
  ]) assert.throws(() => verifyDriverComparisonCore({ ...report, ...alteration }, metadata, 'reference'));
  assert.throws(() => verifyDriverComparisonCore({ ...report, driverSha256: 'candidate-driver' }, metadata, 'candidate'));
});

test('resident load invocation supports legacy and explicitly classified production samples', () => {
  const entry = { mode: 'playwright', scenario: { workload: 'quiet-text', conditionCount: 1 }, launchGroup: 0 };
  const legacy = ['/runtime/node', 'benchmarks/resident-load-sample.mjs', 'playwright', 'quiet-text', '1', '0'];
  verifyResidentLoadInvocation(legacy, entry, undefined);
  verifyResidentLoadInvocation([...legacy, 'comparison'], entry, 2);
  assert.throws(() => verifyResidentLoadInvocation(legacy, entry, 2));
  assert.throws(() => verifyResidentLoadInvocation([...legacy, 'comparison'], entry, undefined));
  assert.throws(() => verifyResidentLoadInvocation([...legacy, 'functional-conformance'], entry, 2));
  assert.throws(() => verifyResidentLoadInvocation([...legacy, 'comparison', 'extra'], entry, 2));
  assert.throws(() => verifyResidentLoadInvocation(['/runtime/node', '--unexpected', ...legacy.slice(1), 'comparison'], entry, 2));
  assert.throws(() => verifyResidentLoadInvocation([...legacy, 'comparison'], entry, 3));
  for (const altered of [{ ...entry, mode: 'flashwright-on' }, { ...entry, launchGroup: 1 },
    { ...entry, scenario: { workload: 'property-only', conditionCount: 1 } },
    { ...entry, scenario: { workload: 'quiet-text', conditionCount: 128 } }]) {
    assert.throws(() => verifyResidentLoadInvocation([...legacy, 'comparison'], altered, 2));
  }
});

test('statistics preserve independent-launch units and do not invent tail estimates', () => {
  const policy = { seed: 1, bootstrapReplicates: 1000, confidenceLevel: 0.95, minimumSamplesForP95: 200, minimumSamplesForP99: 1000 };
  const result = summarize([[1, 2, 3], [7, 8, 9]], policy);
  assert.deepEqual(result.launchMedians, [2, 8]);
  assert.equal(result.medianMilliseconds, 5);
  assert.equal(result.observedMaximumMilliseconds, 9);
  assert.equal(result.p95Milliseconds, null);
  assert.equal(result.p99Milliseconds, null);
  assert.deepEqual(result.launchMedianConfidenceInterval, [2, 8]);
  assert.equal(quantile([], 0.5), null);
});

test('paired comparisons retain launch correspondence and reject incomplete pairs', () => {
  const policy = { seed: 1, bootstrapReplicates: 1000, confidenceLevel: 0.95, minimumSamplesForP95: 200, minimumSamplesForP99: 1000 };
  const result = comparePaired([[10, 10, 10], [100, 100, 100]], [[5, 5, 5], [50, 50, 50]], policy);
  assert.deepEqual(result.speedupRatios, [2, 2]);
  assert.equal(result.medianPairedSpeedup, 2);
  assert.deepEqual(result.pairedSpeedupConfidenceInterval, [2, 2]);
  assert.throws(() => comparePaired([[1]], [], policy), /complete positive samples/);
  assert.throws(() => comparePaired([[1], []], [[1], [1]], policy), /complete positive samples/);
});

test('actual launch comparison normalizes only owned profile paths', () => {
  const browser = '/browser path/Chrome';
  const reference = '2026 pw:browser <launching> /browser path/Chrome --headless --user-data-dir=/tmp/reference --remote-debugging-pipe\n';
  const native = 'flashwright:browser <launching> ' + JSON.stringify({ executable: browser, arguments: ['--headless', '--user-data-dir=/tmp/native', '--remote-debugging-pipe'] });
  assert.deepEqual(launchArguments(reference, 'playwright', browser), launchArguments(native, 'flashwright', browser));
  assert.throws(() => launchArguments(reference + reference, 'playwright', browser), /exactly one/);
  assert.throws(() => launchArguments(reference, 'playwright', '/another/browser'), /path differs/);
});


test('benchmark admission binds core verification to the exact browser executable', () => {
  const browser = { executablePath: '/pinned/chrome', sha256: 'full-browser-hash', version: '148.0.7778.96', distribution: 'full-chromium' };
  const report = { browser, browserChangedDuringVerification: false };
  requireVerifiedBrowser(report, browser);
  requireVerifiedBrowser(report, { ...browser, executablePath: undefined, path: browser.executablePath });
  assert.throws(() => requireVerifiedBrowser({}, browser), /no executable identity/);
  assert.throws(() => requireVerifiedBrowser({ ...report, browserChangedDuringVerification: true }, browser), /changed during/);
  assert.throws(() => requireVerifiedBrowser(report, { ...browser, executablePath: '/pinned/chrome-headless-shell' }), /browser path/);
  assert.throws(() => requireVerifiedBrowser(report, { ...browser, sha256: 'replacement-with-same-version' }), /browser executable/);
  assert.throws(() => requireVerifiedBrowser(report, { ...browser, version: '148.0.7778.97' }), /browser version/);
  assert.throws(() => requireVerifiedBrowser(report, { ...browser, distribution: 'chromium-headless-shell' }), /browser distribution/);
});


test('fixture shutdown closes listening and active HTTP connections under the selected runtime', async () => {
  const { server, close: closeServer } = createHttpFixture(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = connect(server.address().port, '127.0.0.1');
  const disconnected = once(client, 'close');
  try {
    await once(client, 'connect');
    const requested = once(server, 'request');
    client.write('GET /pending HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await requested;
    await closeServer();
    await disconnected;
    assert.equal(server.listening, false);
    assert.equal(client.destroyed, true);
    await assert.rejects(closeServer(), { code: 'ERR_SERVER_NOT_RUNNING' });
  } finally {
    client.destroy();
    if (server.listening) await closeServer();
  }
});
