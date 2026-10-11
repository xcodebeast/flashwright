import { requireBun } from './bun-toolchain.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { sourceManifest } from './source-manifest.mjs';
import { collectRustDependencyNotices } from './rust-dependency-notices.mjs';
import { verifyDriverBinaryPaths } from './verify-driver-binary-paths.mjs';

const require = createRequire(import.meta.url);
const { EngineClient } = require('../packages/flashwright-core/dist/commonjs/client.js');
const { engineHandshake } = require('../packages/flashwright-core/dist/commonjs/engine-contract.js');
const { driverPackageName, verifyInstalledDriver, verifyDriverHeader } = require('../packages/flashwright-core/dist/commonjs/driver-runtime.js');
const { residentRuntimeSha256 } = require('../packages/flashwright-core/dist/commonjs/runtime-version.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const arguments_ = process.argv.slice(2);
const options = {};
for (let index = 0; index < arguments_.length; index += 2) {
  const name = arguments_[index];
  assert.ok(['--driver', '--destination'].includes(name) && arguments_[index + 1] && !Object.hasOwn(options, name), 'Usage: bun tools/pack-driver-runtime.mjs --driver EXECUTABLE [--destination NEW_DIRECTORY]');
  options[name] = arguments_[index + 1];
}
assert.ok(options['--driver'], 'Pass --driver with the built executable for this host');
const sources = await sourceManifest();
const packageName = driverPackageName(process.platform, process.arch);
const library = JSON.parse(await readFile('packages/flashwright-core/package.json', 'utf8'));
assert.equal(library.version, engineHandshake.packageVersion);
assert.equal(library.optionalDependencies[packageName], library.version);
const requestedDestination = resolve(options['--destination'] ?? `.cache/driver-runtime-${process.platform}-${process.arch}-${randomUUID()}`);
await mkdir(requestedDestination);
const destination = await realpath(requestedDestination);
const directory = join(destination, 'package');
await mkdir(join(directory, 'bin'), { recursive: true });
const executable = join(directory, 'bin/flashwright-driver');
await copyFile(resolve(options['--driver']), executable);
await chmod(executable, 0o755);
const executableBytes = await readFile(executable);
await verifyDriverBinaryPaths(executableBytes);
verifyDriverHeader(executableBytes, { platform: process.platform, architecture: process.arch });
const client = new EngineClient(executable);
client.retain();
try { await client.waitForHandshake(); } finally { await client.release(); }
const manifest = {
  schemaVersion: 1, packageName, packageVersion: library.version,
  platform: process.platform, architecture: process.arch,
  protocolVersion: engineHandshake.protocolVersion, capabilityInventoryVersion: engineHandshake.capabilityInventoryVersion,
  residentRuntimeSha256, executablePath: 'bin/flashwright-driver',
  executableBytes: executableBytes.length, executableSha256: hash(executableBytes),
};
const commandText = (program, arguments_) => execFileSync(program, arguments_, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
if (process.platform === 'linux') {
  const versions = [...commandText('readelf', ['--version-info', executable]).matchAll(/Name: GLIBC_([0-9.]+)/g)].map(match => match[1]);
  assert.ok(versions.length, 'The Linux runtime must declare its actual glibc symbol requirements');
  versions.sort((first, second) => {
    const firstParts = first.split('.').map(Number), secondParts = second.split('.').map(Number);
    for (let index = 0; index < 3; index++) if ((firstParts[index] ?? 0) !== (secondParts[index] ?? 0)) return (firstParts[index] ?? 0) - (secondParts[index] ?? 0);
    return 0;
  });
  manifest.minimumGlibcVersion = versions.at(-1);
  manifest.systemLibraries = [...commandText('readelf', ['--dynamic', executable]).matchAll(/\(NEEDED\).*Shared library: \[([^\]]+)\]/g)].map(match => match[1]);
} else {
  manifest.systemLibraries = commandText('otool', ['-L', executable]).trim().split('\n').slice(1).map(line => line.trim().split(' (')[0]);
}
const packageManifest = {
  name: packageName, version: library.version, private: true, license: 'UNLICENSED',
  description: `Private development build of the Flashwright driver for ${process.platform}/${process.arch}`,
  os: [process.platform], cpu: [process.arch], ...(process.platform === 'linux' ? { libc: ['glibc'] } : {}),
  preferUnplugged: true, exports: { './package.json': './package.json' },
  files: ['bin', 'runtime.json', 'provenance.json', 'licenses'],
};
await writeFile(join(directory, 'package.json'), JSON.stringify(packageManifest, null, 2) + '\n');
await writeFile(join(directory, 'runtime.json'), JSON.stringify(manifest, null, 2) + '\n');
const licenses = [];
const rust = commandText('rustc', ['-vV']).trim();
const target = rust.match(/^host: (.+)$/m)?.[1];
assert.ok(target);
const metadata = JSON.parse(commandText('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', target]));
const supplements = JSON.parse(await readFile('compatibility/upstream/rust-license-supplements.json', 'utf8'));
for (const dependency of await collectRustDependencyNotices(metadata, supplements)) {
  const relative = `licenses/rust-dependencies/${dependency.name}-${dependency.version}`;
  await mkdir(join(directory, relative), { recursive: true });
  for (const document of dependency.documents) await cp(document.path, join(directory, relative, document.name), { recursive: true });
  const { documents, ...provenance } = dependency;
  licenses.push({ ...provenance, directory: relative });
}
const sysroot = commandText('rustc', ['--print', 'sysroot']).trim();
await mkdir(join(directory, 'licenses/rust-standard-library'), { recursive: true });
await copyFile(join(sysroot, 'share/doc/rust/COPYRIGHT-library.html'), join(directory, 'licenses/rust-standard-library/COPYRIGHT-library.html'));
await cp(join(sysroot, 'share/doc/rust/licenses'), join(directory, 'licenses/rust-standard-library/licenses'), { recursive: true });
await mkdir(join(directory, 'licenses/playwright'));
for (const name of ['LICENSE.playwright', 'NOTICE.playwright']) await copyFile(`compatibility/upstream/${name}`, join(directory, 'licenses/playwright', name));
await writeFile(join(directory, 'provenance.json'), JSON.stringify({ schemaVersion: 1, rust, target, sources, dependencies: licenses,
  scope: 'Private packed development runtime. A successful handshake validates protocol and resident runtime identity; browser conformance, native platform and release gates are separate.' }, null, 2) + '\n');
const report = process.platform === 'linux' ? process.report.getReport() : undefined;
assert.equal(verifyInstalledDriver(join(directory, 'package.json'), { platform: process.platform, architecture: process.arch, glibcVersion: report?.header.glibcVersionRuntime }), executable);
assert.deepEqual(await sourceManifest(), sources, 'Sources changed while packaging');
const archive = join(destination, `${packageName.replace('@', '').replace('/', '-')}-${library.version}.tgz`);
execFileSync(requireBun(), ['pm', 'pack', '--filename', archive, '--ignore-scripts', '--quiet'], { cwd: directory, encoding: 'utf8' });
const receipt = { status: 'passed', kind: 'private-platform-runtime', ...runtimeMetadata, platform: process.platform, architecture: process.arch,
  archive, archiveSha256: hash(await readFile(archive)), integrity: `sha512-${createHash('sha512').update(await readFile(archive)).digest('base64')}`, packageManager: 'bun@1.4.2', manifest, sources };
await writeFile(join(destination, 'report.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ destination, archive, sha256: receipt.archiveSha256, manifest }, null, 2));
