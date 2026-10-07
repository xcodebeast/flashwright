import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const raw = await readFile('test-results/runner-boundary.json');
const report = JSON.parse(raw);
function allSpecs(suites) {
  return suites.flatMap(suite => [...suite.specs, ...allSpecs(suite.suites ?? [])]);
}
const specs = allSpecs(report.suites);
assert.equal(specs.length, 5);
assert.equal(report.stats.unexpected, 1, 'Exactly the deliberate timeout must fail the nested runner.');
assert.equal(report.stats.flaky, 1, 'The intentionally failed first attempt must be retried.');
const retries = specs.find(spec => spec.title === 'uses runner retries').tests[0].results;
assert.deepEqual(retries.map(result => result.status), ['failed', 'passed']);
const soft = specs.find(spec => spec.title === 'soft matcher failure reaches runner status').tests[0];
assert.equal(soft.expectedStatus, 'failed');
assert.equal(soft.results[0].errors.length, 1);
const timedOut = specs.find(spec => spec.title === 'runner timeout still tears down dependent fixtures').tests[0];
assert.equal(timedOut.status, 'unexpected');
assert.deepEqual(timedOut.results.map(result => result.status), ['timedOut', 'timedOut']);
assert(specs.filter(spec => spec.tests[0].status === 'unexpected').every(spec => spec.title === 'runner timeout still tears down dependent fixtures'));
for (const spec of specs) {
  for (const result of spec.tests[0].results) {
    assert(result.attachments.some(attachment => attachment.name === 'probe-disposed'), `Missing fixture teardown for ${spec.title}`);
  }
}
const destination = `compatibility/evidence/runner-boundary-${process.platform}-${process.arch}-${process.versions.node}.json`;
await mkdir('compatibility/evidence', { recursive: true });
const hashes = {};
for (const source of ['compatibility/runner-boundary/adapter.ts', 'compatibility/runner-boundary/boundary.spec.ts', 'compatibility/runner-boundary/playwright.config.ts', 'tools/verify-runner-boundary.mjs', 'tools/run-runner-boundary.mjs', 'package-lock.json']) {
  hashes[source] = createHash('sha256').update(await readFile(source)).digest('hex');
}
await writeFile(destination, JSON.stringify({
  verifiedAt: new Date().toISOString(), reference: '1.60.0', node: process.version,
  platform: process.platform, architecture: process.arch, sourceHashes: hashes,
  rawReportSha256: createHash('sha256').update(raw).digest('hex'),
  checks: ['isolated upstream runner dependency identity', 'extended fixtures', 'custom option forwarding', 'worker scope', 'async custom matchers', 'negation', 'configured expect', 'soft failure status', 'steps', 'reporter attachments', 'retries', 'timeout teardown', 'upstream launch/connect/request paths poisoned'],
  limitations: ['Probe uses no browser objects; browser-operation cancellation and artifact integration remain M2 gates.', 'Packed adapter and alias dependency isolation remain unverified.'],
  report,
}, null, 2) + '\n');
console.log(`Verified runner boundary: ${destination}`);
