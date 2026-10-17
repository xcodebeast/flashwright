import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { finalGoalAccountingClasses } from '../benchmarks/final-goal-resource-policy.mjs';

export const linuxResourceEvidenceLimits = Object.freeze({
  maximumAggregateBytes: 96 * 1024 ** 2,
  maximumHeaderBytes: 16 * 1024,
  maximumOutputBytes: 8 * 1024 ** 2,
  timeoutMilliseconds: 30000,
  files: Object.freeze({ capture: 32 * 1024 ** 2, before: 32 * 1024 ** 2, after: 32 * 1024 ** 2, native: 4 * 1024 ** 2 }),
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Validate the entire inventory before asking a custody-aware reader for bytes. */
export async function loadFinalGoalLinuxEvidence(manifest, readBytes) {
  assert.deepEqual(Object.keys(manifest ?? {}).sort(), ['accountingClass', 'files', 'schemaVersion']);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.accountingClass, finalGoalAccountingClasses.linux);
  assert.deepEqual(Object.keys(manifest.files ?? {}).sort(), Object.keys(linuxResourceEvidenceLimits.files).sort());
  let total = 0;
  const paths = new Set();
  for (const [name, maximum] of Object.entries(linuxResourceEvidenceLimits.files)) {
    const receipt = manifest.files[name];
    assert.deepEqual(Object.keys(receipt ?? {}).sort(), ['bytes', 'path', 'sha256']);
    assert(typeof receipt.path === 'string' && receipt.path.length > 0 && receipt.path.length <= 4096
      && !receipt.path.includes('\0') && !receipt.path.includes('\\') && !posix.isAbsolute(receipt.path)
      && posix.normalize(receipt.path) === receipt.path && !receipt.path.split('/').some(part => ['', '.', '..'].includes(part)),
    'Retained Linux path must be relative and contained');
    assert(!paths.has(receipt.path), 'Retained Linux original path reused');
    paths.add(receipt.path);
    assert.match(receipt.sha256 ?? '', /^[a-f0-9]{64}$/);
    assert(Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0 && receipt.bytes <= maximum, 'Retained Linux file byte limit exceeded');
    total += receipt.bytes;
  }
  assert(total <= linuxResourceEvidenceLimits.maximumAggregateBytes, 'Retained Linux aggregate byte limit exceeded');
  const originals = {};
  for (const [name, maximumFileBytes] of Object.entries(linuxResourceEvidenceLimits.files)) {
    const receipt = manifest.files[name];
    const bytes = await readBytes(receipt, { maximumFileBytes, expectedSize: receipt.bytes });
    assert(Buffer.isBuffer(bytes) && bytes.length === receipt.bytes, 'Retained Linux original size differs');
    assert.equal(digest(bytes), receipt.sha256, 'Retained Linux original bytes changed');
    originals[name] = bytes;
  }
  return originals;
}

/** Reuse the bounded Python derivation; original absolute paths remain inert data. */
export async function reconstructFinalGoalLinuxResourceEvidence(manifest, readBytes) {
  const originals = await loadFinalGoalLinuxEvidence(manifest, readBytes);
  const header = { schemaVersion: 1, accountingClass: finalGoalAccountingClasses.linux,
    files: Object.fromEntries(Object.entries(manifest.files).map(([name, receipt]) => [name, { bytes: receipt.bytes, sha256: receipt.sha256 }])) };
  const headerBytes = Buffer.from(JSON.stringify(header) + '\n');
  assert(headerBytes.length <= linuxResourceEvidenceLimits.maximumHeaderBytes);
  const output = await new Promise((resolve, reject) => {
    let inputError;
    const child = execFile('python3', ['-B', fileURLToPath(new URL('./final_goal_linux_evidence.py', import.meta.url)), '--stdin'],
      { timeout: linuxResourceEvidenceLimits.timeoutMilliseconds, killSignal: 'SIGKILL',
        maxBuffer: linuxResourceEvidenceLimits.maximumOutputBytes, encoding: 'buffer' }, (error, stdout) => {
        if (error || inputError) reject(error ?? inputError);
        else resolve(stdout);
      });
    child.stdin.on('error', error => { inputError = error; });
    const source = Readable.from([headerBytes, ...Object.keys(linuxResourceEvidenceLimits.files).map(name => originals[name])]);
    source.on('error', error => { inputError = error; child.kill('SIGKILL'); });
    child.once('close', () => source.destroy());
    source.pipe(child.stdin);
  });
  const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output));
  assert.equal(result.status, 'verified-local-observations');
  assert.equal(result.accountingClass, finalGoalAccountingClasses.linux);
  assert.equal(result.resourceAdmission, false);
  assert.equal(result.performanceAccepted, false);
  assert.deepEqual(result.retainedOriginals, header.files);
  return result;
}
