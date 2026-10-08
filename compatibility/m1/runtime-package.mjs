import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, copyFile, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chromium } from 'flashwright';

const require = createRequire(import.meta.url);
const packagePath = require.resolve(`@flashwright/driver-${process.platform}-${process.arch}/package.json`);
const root = dirname(packagePath);
const manifestPath = join(root, 'runtime.json');
const executablePath = join(root, 'bin/flashwright-driver');
const original = new Map(await Promise.all([packagePath, manifestPath, executablePath].map(async path => [path, await readFile(path)])));
const checks = [];
const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2));
const manifest = JSON.parse(original.get(manifestPath));
const noSpawnProbe = `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
let spawned = 0;
childProcess.spawn = () => { spawned++; throw new Error('invalid artifact reached spawn'); };
const { chromium } = await import('flashwright');
await assert.rejects(chromium.launch(), error => error.name === process.env.EXPECTED_ERROR && error.message.includes(process.env.EXPECTED_MESSAGE));
assert.equal(spawned, 0);
`;
await writeFile('runtime-no-spawn.mjs', noSpawnProbe);
async function restore() {
  await rm(executablePath, { force: true });
  for (const [path, bytes] of original) await writeFile(path, bytes);
  await chmod(executablePath, 0o755);
}
async function rejected(name, mutate, expectedMessage, expectedError = 'ProtocolError') {
  await mutate();
  try {
    const child = spawnSync(process.execPath, ['runtime-no-spawn.mjs'], { env: { ...process.env, EXPECTED_ERROR: expectedError, EXPECTED_MESSAGE: expectedMessage }, encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 0, `${name}: ${child.stdout}\n${child.stderr}`);
    checks.push(name);
  } finally { await restore(); }
}
try {
  const browsers = await Promise.all([chromium.launch(), chromium.launch()]);
  try {
    const pages = await Promise.all(browsers.map(browser => browser.newPage()));
    await pages[0].evaluate(() => { window.owner = 'first'; });
    assert.equal(await pages[1].evaluate(() => window.owner), undefined);
    await browsers[0].close();
    assert.equal(await pages[1].evaluate(() => 42), 42);
  } finally { await Promise.all(browsers.map(browser => browser.close())); }
  checks.push('concurrent packaged browsers preserve ownership through partial close');
  const outside = join(process.cwd(), 'outside-driver');
  await copyFile(executablePath, outside);
  await rejected('package version mismatch', () => writeJson(packagePath, { ...JSON.parse(original.get(packagePath)), version: '0.0.1' }), 'package identity');
  for (const [field, value] of [['schemaVersion', 99], ['packageVersion', '0.0.1'], ['platform', 'unsupported'], ['architecture', 'unsupported'], ['protocolVersion', 99], ['capabilityInventoryVersion', 99], ['residentRuntimeSha256', '0'.repeat(64)]]) {
    await rejected(`${field} mismatch`, () => writeJson(manifestPath, { ...manifest, [field]: value }), `manifest ${field}`);
  }
  await rejected('malformed runtime JSON', () => writeFile(manifestPath, '{'), 'cannot verify');
  await rejected('oversized runtime manifest', () => writeFile(manifestPath, ' '.repeat(65537)), 'manifest file');
  await rejected('oversized executable declaration', () => writeJson(manifestPath, { ...manifest, executableBytes: 128 * 1024 * 1024 + 1 }), 'executable record');
  await rejected('executable path traversal', () => writeJson(manifestPath, { ...manifest, executablePath: '../outside-driver' }), 'executable record');
  await rejected('executable symlink outside package', async () => { await rm(executablePath); await symlink(outside, executablePath); }, 'escapes its package');
  await rejected('executable size mismatch', () => writeFile(executablePath, original.get(executablePath).subarray(1)), 'executable size');
  await rejected('same-size binary corruption', async () => { const bytes = Buffer.from(original.get(executablePath)); bytes[bytes.length - 1] ^= 1; await writeFile(executablePath, bytes); }, 'checksum');
  await rejected('mislabeled executable architecture', async () => {
    const bytes = Buffer.from(original.get(executablePath));
    if (process.platform === 'darwin') bytes.writeUInt32LE(0x01000007, 4);
    else bytes.writeUInt16LE(183, 18);
    await writeFile(executablePath, bytes);
    await writeJson(manifestPath, { ...manifest, executableSha256: createHash('sha256').update(bytes).digest('hex') });
  }, 'executable format or architecture');
  await rejected('missing executable', () => rm(executablePath), 'cannot verify');
  await rejected('non-executable artifact', () => chmod(executablePath, 0o644), 'cannot verify');
  if (process.platform === 'linux') await rejected('unsupported glibc version', () => writeJson(manifestPath, { ...manifest, minimumGlibcVersion: '999.0' }), 'requires glibc', 'UnsupportedFeatureError');
  const { driverPackageName } = require(join(dirname(require.resolve('flashwright/package.json')), 'dist/commonjs/driver-runtime.js'));
  for (const [platform, architecture] of [['win32', 'x64'], ['darwin', 'x64'], ['linux', 'arm64']]) {
    assert.throws(() => driverPackageName(platform, architecture), error => error.name === 'UnsupportedFeatureError' && error.message.includes(`${platform}/${architecture}`));
  }
  checks.push('unavailable platforms reject explicitly');
  if (process.platform === 'linux') {
    await writeFile('runtime-musl.mjs', noSpawnProbe.replace("const { chromium }", "process.report.getReport = () => ({ header: {} });\nconst { chromium }"));
    const musl = spawnSync(process.execPath, ['runtime-musl.mjs'], { env: { ...process.env, EXPECTED_ERROR: 'UnsupportedFeatureError', EXPECTED_MESSAGE: 'musl' }, encoding: 'utf8', timeout: 15000 });
    assert.equal(musl.status, 0, musl.stderr); checks.push('musl host rejects before package lookup or spawn');
  }
  const hidden = root + '-hidden';
  await rename(root, hidden);
  try {
    const child = spawnSync(process.execPath, ['runtime-no-spawn.mjs'], { env: { ...process.env, EXPECTED_ERROR: 'UnsupportedFeatureError', EXPECTED_MESSAGE: 'optional dependencies' }, encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 0, child.stderr);checks.push('omitted optional package has installation guidance before spawn');
  } finally { await rename(hidden, root); }
  await writeFile('runtime-deadline.mjs', noSpawnProbe.replace("const { chromium }", "const filesystem = require('node:fs'); const read = filesystem.readSync; filesystem.readSync = (...arguments_) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); return read(...arguments_); };\nconst { chromium }").replace('chromium.launch()', 'chromium.launch({ timeout: 1 })'));
  const deadline = spawnSync(process.execPath, ['runtime-deadline.mjs'], { env: { ...process.env, EXPECTED_ERROR: 'TimeoutError', EXPECTED_MESSAGE: 'resolving the driver' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(deadline.status, 0, deadline.stderr);checks.push('expired package verification cannot spawn a driver');
  await writeFile(manifestPath, '{');
  const override = spawnSync(process.execPath, ['--input-type=module', '-e', "import {chromium} from 'flashwright'; const browser = await chromium.launch(); await browser.close();"], { env: { ...process.env, FLASHWRIGHT_DRIVER_PATH: outside }, encoding: 'utf8', timeout: 20000 });
  assert.equal(override.status, 0, override.stderr);checks.push('explicit compatible override bypasses invalid optional package');
  await restore();
  await writeFile('runtime-package-checks.json', JSON.stringify({ status: 'passed', checks }, null, 2) + '\n');
  console.log(`Verified ${checks.length} platform package ownership, integrity and deadline cases.`);
} finally { await restore(); }
