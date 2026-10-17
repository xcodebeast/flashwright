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
export const linuxCapturedOutputLimits = Object.freeze({ maximumFiles: 256,
  maximumFileBytes: 32 * 1024 ** 2, maximumAggregateBytes: 128 * 1024 ** 2 });

function containedPath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096
    && !path.includes('\0') && !path.includes('\\') && !posix.isAbsolute(path)
    && posix.normalize(path) === path && !path.split('/').some(part => ['', '.', '..'].includes(part));
}

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
    assert(containedPath(receipt.path), 'Retained Linux path must be relative and contained');
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
  const result = await reconstructLinuxProjection(manifest, readBytes);
  assert.equal(result.status, 'verified-local-observations');
  assert.deepEqual(result.retainedOriginals, Object.fromEntries(Object.entries(manifest.files)
    .map(([name, receipt]) => [name, { bytes: receipt.bytes, sha256: receipt.sha256 }])));
  return result;
}

async function reconstructLinuxProjection(manifest, readBytes, outputInventory = false) {
  const originals = await loadFinalGoalLinuxEvidence(manifest, readBytes);
  const header = { schemaVersion: 1, accountingClass: finalGoalAccountingClasses.linux,
    files: Object.fromEntries(Object.entries(manifest.files).map(([name, receipt]) => [name, { bytes: receipt.bytes, sha256: receipt.sha256 }])) };
  const headerBytes = Buffer.from(JSON.stringify(header) + '\n');
  assert(headerBytes.length <= linuxResourceEvidenceLimits.maximumHeaderBytes);
  const output = await new Promise((resolve, reject) => {
    let inputError;
    const child = execFile('python3', ['-B', fileURLToPath(new URL('./final_goal_linux_evidence.py', import.meta.url)), '--stdin',
      ...(outputInventory ? ['--captured-outputs'] : [])],
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
  assert.equal(result.status, outputInventory ? 'verified-local-output-inventory' : 'verified-local-observations');
  assert.equal(result.accountingClass, finalGoalAccountingClasses.linux);
  assert.equal(result.resourceAdmission, false);
  assert.equal(result.performanceAccepted, false);
  return result;
}

/** Join every retained output to the same original capture, including empty logs and failed outcomes. */
export async function reconstructFinalGoalLinuxCapturedOutputs(resourceManifest, manifest, readBytes) {
  assert.deepEqual(Object.keys(manifest ?? {}).sort(), ['accountingClass', 'captureSha256', 'outputs', 'schemaVersion']);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.accountingClass, finalGoalAccountingClasses.linux);
  assert.match(manifest.captureSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(manifest.captureSha256, resourceManifest.files?.capture?.sha256, 'Output manifest borrows another capture');
  assert(Array.isArray(manifest.outputs) && manifest.outputs.length > 0
    && manifest.outputs.length <= linuxCapturedOutputLimits.maximumFiles, 'Invalid retained output inventory');
  const paths = new Set(Object.values(resourceManifest.files ?? {}).map(receipt => receipt.path));
  const originals = new Set();
  let total = 0;
  for (const receipt of manifest.outputs) {
    assert.deepEqual(Object.keys(receipt ?? {}).sort(), ['bytes', 'originalPath', 'path', 'sha256']);
    assert(containedPath(receipt.path) && !paths.has(receipt.path), 'Retained output path must be unique and contained');
    paths.add(receipt.path);
    assert(typeof receipt.originalPath === 'string' && receipt.originalPath.length > 0 && receipt.originalPath.length <= 4096
      && !receipt.originalPath.includes('\0') && !receipt.originalPath.includes('\\') && posix.isAbsolute(receipt.originalPath)
      && posix.normalize(receipt.originalPath) === receipt.originalPath && !originals.has(receipt.originalPath),
    'Invalid or reused original output path');
    originals.add(receipt.originalPath);
    assert(Number.isSafeInteger(receipt.bytes) && receipt.bytes >= 0 && receipt.bytes <= linuxCapturedOutputLimits.maximumFileBytes,
      'Retained output file byte limit exceeded');
    assert.match(receipt.sha256 ?? '', /^[a-f0-9]{64}$/);
    total += receipt.bytes;
  }
  assert(total <= linuxCapturedOutputLimits.maximumAggregateBytes, 'Retained output aggregate byte limit exceeded');
  const inventory = await reconstructLinuxProjection(resourceManifest, readBytes, true);
  assert.equal(inventory.captureSha256, manifest.captureSha256);
  assert.deepEqual(inventory.outputs, manifest.outputs.map(({ originalPath, bytes, sha256 }) => ({ originalPath, bytes, sha256 })),
    'Retained outputs differ from original captured inventory');
  for (const receipt of manifest.outputs) {
    const bytes = await readBytes(receipt, { maximumFileBytes: linuxCapturedOutputLimits.maximumFileBytes, expectedSize: receipt.bytes });
    assert(Buffer.isBuffer(bytes) && bytes.length === receipt.bytes, 'Retained output size differs');
    assert.equal(digest(bytes), receipt.sha256, 'Retained output bytes changed');
  }
  return { ...inventory, status: 'verified-retained-captured-outputs', outputs: structuredClone(manifest.outputs) };
}
