import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireBun, bunVersion } from './bun-toolchain.mjs';
import { startConsumerRegistry } from './consumer-registry.mjs';

const ownedInstallations = new WeakMap();
const disposableChildren = ['install-cache', 'node_modules'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function directoryIdentity(directory) {
  const identity = await lstat(directory);
  assert.ok(identity.isDirectory() && !identity.isSymbolicLink(), 'Packed consumer root must be a real directory');
  if (process.getuid) assert.equal(identity.uid, process.getuid(), 'Packed consumer root must belong to the current user');
  return { path: await realpath(directory), device: identity.dev, inode: identity.ino };
}

async function existingChild(directory, name) {
  try { return await lstat(join(directory, name)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Exercise unchanged package versions through normal registry resolution in a fresh cache. */
export async function installPackedConsumer(directory, archives) {
  const identity = await directoryIdentity(resolve(directory));
  for (const name of disposableChildren) assert.equal(await existingChild(identity.path, name), null, 'Packed consumer installation must start without disposable children');
  const archiveInputs = Object.fromEntries(await Promise.all(archives.map(async archive => [resolve(archive), hash(await readFile(archive))])));
  const registry = await startConsumerRegistry(archives);
  const command = [requireBun(), 'install', '--ignore-scripts', '--registry', registry.url];
  let output = '';
  let installation;
  try {
    const child = spawn('python3', [resolve('tools/watchdog.py'), '--timeout', '180', '--', ...command], {
      cwd: directory, env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(directory, 'install-cache') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    await writeFile(join(directory, 'install.log'), output);
    assert.equal(code, 0, output);
    installation = { packageManager: `bun@${bunVersion}`, command, code, registryRequests: registry.requests,
      logSha256: createHash('sha256').update(output).digest('hex'), log: join(directory, 'install.log') };
  } finally { await registry.close(); }
  ownedInstallations.set(installation, { identity, archiveInputs });
  return installation;
}

async function retainedInputIdentities(directory, evidencePath, callerSource, archiveInputs) {
  const inputs = new Set([
    evidencePath, fileURLToPath(callerSource), fileURLToPath(import.meta.url),
    ...['packed-artifacts.mjs', 'bun-toolchain.mjs', 'consumer-registry.mjs', 'watchdog.py'].map(name => fileURLToPath(new URL(name, import.meta.url))),
    ...Object.keys(archiveInputs), join(directory, 'package.json'), join(directory, 'bun.lock'), join(directory, 'install.log'),
  ]);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name !== 'cleanup-receipt.json') inputs.add(join(directory, entry.name));
  }
  const identities = {};
  for (const input of inputs) {
    const path = resolve(input);
    for (const name of disposableChildren) assert.ok(path !== join(directory, name) && !path.startsWith(join(directory, name) + '/'), 'Retained inputs cannot be inside disposable children');
    const identity = await lstat(path);
    assert.ok(identity.isFile() && !identity.isSymbolicLink(), `Retained input must be a real file: ${path}`);
    identities[path] = hash(await readFile(path));
  }
  for (const [path, expected] of Object.entries(archiveInputs)) assert.equal(identities[path], expected, `Packed archive changed: ${path}`);
  return identities;
}

async function filesystemSpace(directory) {
  const information = await statfs(directory, { bigint: true });
  return { availableBytes: String(information.bavail * information.bsize), freeBytes: String(information.bfree * information.bsize), blockSize: String(information.bsize) };
}

/** Called only after successful owner shutdown and persistence of the original verification evidence. */
export async function cleanupPackedConsumer(directory, installation, evidencePath, callerSource) {
  const receipt = { schemaVersion: 1, verificationStatus: 'passed', status: 'pending', requestedDirectory: resolve(directory), removedPaths: [], removalAttempts: [], retainedInputScope: 'Exact top-level consumer files, packed archives, evidence and producer/helper source inputs. Other consumer directories remain untouched.' };
  let receiptPath;
  try {
    const ownership = ownedInstallations.get(installation);
    assert.ok(ownership, 'Cleanup requires this process’s successful installation result');
    assert.deepEqual(await directoryIdentity(resolve(directory)), ownership.identity, 'Packed consumer root identity changed');
    const root = ownership.identity.path;
    receiptPath = join(root, 'cleanup-receipt.json');
    receipt.consumerDirectory = root;
    receipt.ownerProcess = process.pid;
    receipt.rootIdentity = ownership.identity;
    receipt.evidencePath = resolve(evidencePath);
    receipt.startedAt = new Date().toISOString();
    receipt.filesystemBefore = await filesystemSpace(root);
    receipt.retainedInputsBefore = await retainedInputIdentities(root, evidencePath, callerSource, ownership.archiveInputs);
    const targets = [];
    for (const name of disposableChildren) {
      const identity = await existingChild(root, name);
      if (!identity) continue;
      assert.ok(identity.isDirectory() && !identity.isSymbolicLink(), `Disposable child must be a real directory: ${name}`);
      if (process.getuid) assert.equal(identity.uid, process.getuid(), `Disposable child must belong to the current user: ${name}`);
      const path = join(root, name);
      assert.equal(await realpath(path), path, 'Disposable child cannot redirect outside its consumer');
      targets.push({ name, path, device: identity.dev, inode: identity.ino });
    }
    receipt.targets = targets;
    for (const target of targets) {
      assert.deepEqual(await directoryIdentity(root), ownership.identity, 'Packed consumer root changed before cleanup');
      const identity = await existingChild(root, target.name);
      assert.ok(identity?.isDirectory() && !identity.isSymbolicLink() && identity.dev === target.device && identity.ino === target.inode, 'Disposable child changed before cleanup');
      const removal = { path: target.path, status: 'started' };
      receipt.removalAttempts.push(removal);
      await rm(target.path, { recursive: true, force: false });
      removal.status = 'removed';
      receipt.removedPaths.push(target.path);
    }
    receipt.retainedInputsAfter = await retainedInputIdentities(root, evidencePath, callerSource, ownership.archiveInputs);
    assert.deepEqual(receipt.retainedInputsAfter, receipt.retainedInputsBefore, 'Retained inputs changed during cleanup');
    receipt.status = 'passed';
    ownedInstallations.delete(installation);
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = { name: error.name, message: error.message, code: error.code ?? null, path: error.path ?? null };
  }
  if (receiptPath) {
    try {
      assert.deepEqual(await directoryIdentity(receipt.consumerDirectory), receipt.rootIdentity, 'Packed consumer root changed before receipt persistence');
      try { receipt.filesystemAfter = await filesystemSpace(receipt.consumerDirectory); }
      catch (error) {
        receipt.status = 'failed';
        receipt.filesystemError = { name: error.name, message: error.message, code: error.code ?? null };
      }
      receipt.finishedAt = new Date().toISOString();
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    } catch (error) {
      receipt.status = 'failed';
      receipt.receiptError = { name: error.name, message: error.message, code: error.code ?? null };
    }
  }
  if (receipt.status === 'failed') console.error(`Packed consumer cleanup failed; original verification result remains passed: ${JSON.stringify(receipt)}`);
  else console.log(`Packed consumer cleanup passed: ${receiptPath}`);
  return receipt;
}
