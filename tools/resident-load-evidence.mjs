import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { requireVerifiedBrowser } from './browser-identity.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Admit only a complete matching core run, including this workload's functional contract. */
export function verifyLoadCoreReport(report, metadata, residentAssertions) {
  assert.equal(report.status, 'passed');
  assert.equal(report.sourceChangedDuringVerification, false);
  requireVerifiedBrowser(report, metadata.browser);
  for (const field of ['node', 'platform', 'architecture']) assert.equal(report[field], metadata[field]);
  assert.equal(report.driverSha256, metadata.driver.sha256);
  assert.deepEqual(report.sources, metadata.sources);
  assert.deepEqual(report.engineConfiguration, { residentAssertions, conditionInstrumentation: false });
  assert.ok(report.checks.length >= 26);
  assert.ok(report.checks.some(check => check.command.join(' ') === 'npm run test:resident-load'));
  for (const check of report.checks) {
    assert.equal(check.code, 0);
    assert.equal(basename(check.log), check.log);
  }
}

/** Bundle the admitted reports and logs so historical verification never depends on absolute paths. */
export async function retainLoadCoreReport(sourcePath, destination, mode, metadata) {
  const bytes = await readFile(sourcePath);
  const report = JSON.parse(bytes);
  verifyLoadCoreReport(report, metadata, mode === 'on');
  const prefix = `verification/${mode}`;
  await mkdir(join(destination, prefix), { recursive: true });
  const retainedNames = [];
  for (const check of report.checks) {
    const log = await readFile(join(dirname(sourcePath), check.log));
    assert.equal(sha256(log), check.logSha256);
    const name = `${prefix}/${check.log}`;
    await writeFile(join(destination, name), log, { flag: 'wx' });
    retainedNames.push(name);
  }
  const name = `${prefix}/report.json`;
  await writeFile(join(destination, name), bytes, { flag: 'wx' });
  retainedNames.push(name);
  return { verification: { path: name, sha256: sha256(bytes) }, retainedNames };
}
