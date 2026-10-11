import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// One real installation exercises cleanup ownership and preserves every rejected attempt.
const helperPath = resolve(process.argv[2] ?? 'tools/install-packed-consumer.mjs');
const workspace = await realpath(await mkdtemp(join(tmpdir(), 'flashwright-packed-cleanup-regression-')));
const consumer = join(workspace, 'consumer');
const resultPath = join(workspace, 'regression-report.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { schemaVersion: 1, status: 'running', scope: 'One lightweight real Bun installation and host filesystem cleanup guards; no browser, framework performance or release admission.', workspace, helperPath, cases: [] };

async function identities(paths) {
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(path))])));
}

async function rejectedCleanup(cleanup, installation, label) {
  const receipt = await cleanup(consumer, installation, report.evidencePath, import.meta.url);
  assert.equal(receipt.status, 'failed', label);
  assert.deepEqual(receipt.removedPaths, [], `${label}: no completed removals`);
  assert.deepEqual(receipt.removalAttempts, [], `${label}: no removal attempted`);
  report.cases.push({ label, receipt });
  return receipt;
}

try {
  const { installPackedConsumer, cleanupPackedConsumer } = await import(pathToFileURL(helperPath).href);
  assert.equal(typeof cleanupPackedConsumer, 'function', 'Use the adopted cleanup helper');
  report.sourceInputsBefore = await identities([helperPath, fileURLToPath(import.meta.url)]);
  await mkdir(consumer);
  const packageStage = join(workspace, 'archive-source');
  await mkdir(join(packageStage, 'package'), { recursive: true });
  const fixturePackage = { name: 'flashwright-cleanup-fixture', version: '0.0.0', files: ['index.js'], main: 'index.js' };
  await writeFile(join(packageStage, 'package/package.json'), JSON.stringify(fixturePackage, null, 2) + '\n');
  await writeFile(join(packageStage, 'package/index.js'), 'module.exports = 42;\n');
  const archive = join(consumer, 'flashwright-cleanup-fixture-0.0.0.tgz');
  execFileSync('tar', ['-czf', archive, '-C', packageStage, 'package'], { stdio: 'inherit' });
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'flashwright-cleanup-regression-consumer', private: true, dependencies: { 'flashwright-cleanup-fixture': '0.0.0' } }, null, 2) + '\n');
  const installation = await installPackedConsumer(consumer, [archive]);
  report.installation = installation;
  const cache = join(consumer, 'install-cache');
  const modules = join(consumer, 'node_modules');
  await mkdir(cache, { recursive: true });
  const cacheMarker = join(cache, 'cleanup-guard-marker.txt');
  const moduleMarker = join(modules, 'cleanup-guard-marker.txt');
  await writeFile(cacheMarker, 'owned installation cache\n');
  await writeFile(moduleMarker, 'owned installed packages\n');
  await mkdir(join(consumer, 'source'), { recursive: true });
  await mkdir(join(consumer, 'artifacts'), { recursive: true });
  await writeFile(join(consumer, 'source/example.js'), 'export const answer = 42;\n');
  await writeFile(join(consumer, 'artifacts/example.txt'), 'retained artifact bytes\n');
  report.evidencePath = join(consumer, 'verification-evidence.json');
  await writeFile(report.evidencePath, JSON.stringify({ status: 'passed', scope: 'Synthetic host fixture only; terminal install watchdog and registry shutdown completed.' }, null, 2) + '\n');
  const retainedPaths = [archive, join(consumer, 'package.json'), join(consumer, 'bun.lock'), join(consumer, 'install.log'), join(consumer, 'source/example.js'), join(consumer, 'artifacts/example.txt'), report.evidencePath];
  const retainedBefore = await identities(retainedPaths);
  const disposableBefore = await identities([cacheMarker, moduleMarker]);

  await rejectedCleanup(cleanupPackedConsumer, { ...installation }, 'fabricated-installation');
  assert.deepEqual(await identities([cacheMarker, moduleMarker]), disposableBefore);
  await assert.rejects(lstat(join(consumer, 'cleanup-receipt.json')), { code: 'ENOENT' });

  const displaced = join(workspace, 'displaced-consumer');
  await rename(consumer, displaced);
  try {
    await symlink(displaced, consumer, 'dir');
    await rejectedCleanup(cleanupPackedConsumer, installation, 'symlink-root');
    assert.ok((await lstat(consumer)).isSymbolicLink());
    assert.deepEqual(await identities([cacheMarker, moduleMarker]), disposableBefore);
    await assert.rejects(lstat(join(displaced, 'cleanup-receipt.json')), { code: 'ENOENT' });
  } finally {
    if ((await lstat(consumer)).isSymbolicLink()) await unlink(consumer);
    await rename(displaced, consumer);
  }

  await rename(consumer, displaced);
  try {
    await mkdir(consumer);
    await mkdir(join(consumer, 'install-cache'));
    await mkdir(join(consumer, 'node_modules'));
    const replacementMarkers = [join(consumer, 'install-cache/replacement.txt'), join(consumer, 'node_modules/replacement.txt')];
    for (const path of replacementMarkers) await writeFile(path, 'unowned replacement bytes\n');
    const replacementBefore = await identities(replacementMarkers);
    await rejectedCleanup(cleanupPackedConsumer, installation, 'replaced-root');
    assert.deepEqual(await identities(replacementMarkers), replacementBefore);
    await assert.rejects(lstat(join(consumer, 'cleanup-receipt.json')), { code: 'ENOENT' });
  } finally {
    await rename(consumer, join(workspace, 'rejected-replacement'));
    await rename(displaced, consumer);
  }
  assert.deepEqual(await identities([cacheMarker, moduleMarker]), disposableBefore);
  assert.deepEqual(await identities(retainedPaths), retainedBefore);
  const outsidePaths = [join(packageStage, 'package/package.json'), join(packageStage, 'package/index.js'), join(workspace, 'rejected-replacement/install-cache/replacement.txt'), join(workspace, 'rejected-replacement/node_modules/replacement.txt')];
  const outsideBefore = await identities(outsidePaths);

  const savedModules = join(workspace, 'saved-node_modules');
  await rename(modules, savedModules);
  try {
    await symlink(savedModules, modules, 'dir');
    const receipt = await rejectedCleanup(cleanupPackedConsumer, installation, 'symlink-second-disposable-child');
    assert.deepEqual(receipt.targets, undefined, 'Both children must validate before deletion begins');
    assert.deepEqual(await identities([cacheMarker, moduleMarker]), disposableBefore);
    assert.ok((await lstat(modules)).isSymbolicLink());
    const failedReceiptPath = join(consumer, 'cleanup-receipt.json');
    const retainedFailurePath = join(consumer, 'cleanup-rejected-symlink-child.json');
    const failedReceipt = JSON.parse(await readFile(failedReceiptPath, 'utf8'));
    assert.equal(failedReceipt.status, 'failed');
    await rename(failedReceiptPath, retainedFailurePath);
    report.failedReceipt = { path: retainedFailurePath, sha256: hash(await readFile(retainedFailurePath)) };
    retainedPaths.push(retainedFailurePath);
    retainedBefore[retainedFailurePath] = report.failedReceipt.sha256;
  } finally {
    if ((await lstat(modules)).isSymbolicLink()) await unlink(modules);
    await rename(savedModules, modules);
  }
  assert.deepEqual(await identities(retainedPaths), retainedBefore);
  assert.deepEqual(await identities([cacheMarker, moduleMarker]), disposableBefore);

  const receipt = await cleanupPackedConsumer(consumer, installation, report.evidencePath, import.meta.url);
  assert.equal(receipt.status, 'passed', JSON.stringify(receipt));
  assert.equal(receipt.verificationStatus, 'passed');
  assert.deepEqual(receipt.removedPaths, [cache, modules]);
  assert.deepEqual(receipt.removalAttempts, [{ path: cache, status: 'removed' }, { path: modules, status: 'removed' }]);
  await assert.rejects(lstat(cache), { code: 'ENOENT' });
  await assert.rejects(lstat(modules), { code: 'ENOENT' });
  assert.deepEqual(await identities(retainedPaths), retainedBefore);
  assert.deepEqual(receipt.retainedInputsAfter, receipt.retainedInputsBefore);
  for (const boundary of ['filesystemBefore', 'filesystemAfter']) {
    for (const field of ['availableBytes', 'freeBytes', 'blockSize']) assert.match(receipt[boundary][field], /^\d+$/);
    assert.ok(BigInt(receipt[boundary].blockSize) > 0n);
  }
  const receiptPath = join(consumer, 'cleanup-receipt.json');
  assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')), receipt);
  report.cases.push({ label: 'restored-owned-installation-success', receiptPath, receiptSha256: hash(await readFile(receiptPath)), receipt });
  assert.deepEqual(await identities(outsidePaths), outsideBefore);
  report.retainedInputs = retainedBefore;
  report.untouchedOutsideInputs = outsideBefore;
  report.sourceInputsAfter = await identities([helperPath, fileURLToPath(import.meta.url)]);
  assert.deepEqual(report.sourceInputsAfter, report.sourceInputsBefore);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: error.message, stack: error.stack };
  throw error;
} finally {
  await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`Packed cleanup host regression evidence: ${resultPath}`);
}
