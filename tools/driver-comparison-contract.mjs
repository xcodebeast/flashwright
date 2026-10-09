import { reportRuntime } from './javascript-runtime.mjs';
import assert from 'node:assert/strict';
import { requireVerifiedBrowser } from './browser-identity.mjs';

const comparisonOnlySources = new Set(['benchmarks/compare-drivers.mjs']);

/** Both binaries must execute identical adapter, workload and measurement code.
 * Backend source differences are intentional and remain recorded in each core report. */
export function verifyDriverComparisonCore(report, metadata, variant) {
  assert.equal(report.status, 'passed');
  assert.equal(report.sourceChangedDuringVerification, false);
  requireVerifiedBrowser(report, metadata.browser);
  assert.deepEqual(reportRuntime(report), reportRuntime(metadata));
  for (const field of ['platform', 'architecture']) assert.equal(report[field], metadata[field]);
  assert.equal(report.driverSha256, metadata.drivers[variant].sha256);
  assert.deepEqual(report.engineConfiguration, metadata.engineConfiguration);
  assert.equal(report.engineConfiguration.conditionInstrumentation, false);
  assert.ok(report.checks.length >= 35, 'Require complete current core coverage');
  assert.ok(report.checks.every(check => check.code === 0));
  if (variant === 'candidate') assert.deepEqual(report.sources, metadata.sources);
  const sharedSources = name => !comparisonOnlySources.has(name) && (
    name.startsWith('packages/') || name.startsWith('benchmarks/') || name.startsWith('crates/flashwright-protocol/') ||
    ['package.json', 'package-lock.json', 'bun.lock', 'tools/javascript-runtime.mjs', 'tools/bun-toolchain.mjs', 'tsconfig.json', 'tools/watchdog.py', 'tools/engine-configuration.mjs',
      'crates/flashwright-browser/src/chromium-launch-policy.json'].includes(name)
  );
  const names = new Set([...Object.keys(report.sources), ...Object.keys(metadata.sources)]);
  for (const name of names) {
    if (sharedSources(name)) {
      assert.equal(typeof report.sources[name], 'string', `Missing verified execution source: ${name}`);
      assert.equal(report.sources[name], metadata.sources[name], `Driver comparison changed shared execution source: ${name}`);
    }
  }
}
