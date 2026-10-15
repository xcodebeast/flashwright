import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { packConsumerPackages } from './packed-artifacts.mjs';
import { requireBun } from './bun-toolchain.mjs';
import { runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { startConsumerRegistry } from './consumer-registry.mjs';

const destination = resolve(`compatibility/evidence/device-catalogue-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(destination, { recursive: true });
const consumer = await mkdtemp(join(tmpdir(), 'flashwright-device-catalogue-'));
const report = { status: 'running', ...runtimeMetadata, sources: await sourceManifest(), artifacts: {}, checks: [] };
let registry;
try {
  const { archives } = await packConsumerPackages(destination);
  for (const [name, archive] of Object.entries(archives)) report.artifacts[name] = { path: archive, sha256: createHash('sha256').update(await readFile(archive)).digest('hex') };
  const typeArchives = [];
  const resolveTypes = createRequire(realpathSync('node_modules/@types/node/package.json'));
  for (const name of ['@types/node', 'undici-types']) {
    const archive = join(destination, name.replaceAll('/', '-') + '.tgz');
    execFileSync(requireBun(), ['pm', 'pack', '--filename', archive, '--ignore-scripts', '--quiet'], { cwd: dirname(resolveTypes.resolve(`${name}/package.json`)), encoding: 'utf8' });
    typeArchives.push(archive);
  }
  registry = await startConsumerRegistry([...Object.values(archives), ...typeArchives]);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'device-catalogue-consumer', private: true, type: 'module', dependencies: { flashwright: '0.0.0', playwright: 'npm:flashwright@0.0.0', '@types/node': '24.10.1' } }, null, 2));
  const child = spawn(requireBun(), ['install', '--ignore-scripts', '--omit=optional', '--omit=peer', '--registry', registry.url], { cwd: consumer, env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(consumer, 'cache') } });
  let install = '';
  child.stdout.on('data', bytes => { install += bytes; });
  child.stderr.on('data', bytes => { install += bytes; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  await writeFile(join(destination, 'install.log'), install);
  assert.equal(code, 0, install);
  const descriptors = JSON.parse(await readFile('node_modules/playwright-core/lib/server/deviceDescriptorsSource.json', 'utf8'));
  await writeFile(join(consumer, 'expected.json'), JSON.stringify(descriptors));
  await writeFile(join(consumer, 'identity.mjs'), `import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { devices as direct } from 'flashwright';
import { devices as aliased } from 'playwright';
const require = createRequire(import.meta.url);
assert.equal(direct, aliased);
assert.equal(direct, require('flashwright').devices);
assert.equal(direct, require('playwright').devices);
assert.deepEqual(direct, JSON.parse(readFileSync('expected.json', 'utf8')));
const consumer = realpathSync('.');
function assertLocal(path) {
  const name = relative(consumer, realpathSync(path));
  assert.ok(name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name), 'Consumer must not borrow a repository dependency: ' + path);
}
for (const name of ['flashwright', 'playwright', '@flashwright/core']) assertLocal(require.resolve(name));
for (const path of Object.keys(require.cache)) assertLocal(path);
// Ancestor packages are resolvable when TMPDIR is in the checkout. Inspect the
// installed closure, including nested packages, instead of ancestor resolution.
const forbidden = new Set(['@flashwright/runner', '@flashwright/test', 'flashwright-upstream-runner', 'playwright-core']);
const installedPackages = new Set();
for (const name of readdirSync('node_modules', { recursive: true })) {
  if (name !== 'package.json' && !name.endsWith(sep + 'package.json')) continue;
  const path = join('node_modules', name);
  assertLocal(path);
  const metadata = JSON.parse(readFileSync(path, 'utf8'));
  if (metadata.name) installedPackages.add(metadata.name);
  assert.ok(!forbidden.has(metadata.name), 'Library-only installation contains ' + metadata.name);
}
assert.ok(installedPackages.has('@flashwright/core'));
assert.ok(installedPackages.has('flashwright'));
console.log(JSON.stringify({ descriptors: Object.keys(direct).length, mixedIdentity: true, runnerInstalled: false, dependencyImportsLocal: true, installedPackages: [...installedPackages].sort() }));
`);
  const runtime = JSON.parse(execFileSync(process.execPath, ['identity.mjs'], { cwd: consumer, encoding: 'utf8' }));
  report.checks.push(runtime);
  for (const extension of ['mts', 'cts']) {
    await writeFile(join(consumer, `consumer.${extension}`), `import { chromium, devices, type DeviceDescriptor, type BrowserContextOptions } from 'playwright';
const preset: DeviceDescriptor = devices['Desktop Chrome'];
const contextOptions: BrowserContextOptions = { ...preset };
async function useDevice() { const browser = await chromium.launch({ executablePath: '/unused/typecheck/browser' }); const context = await browser.newContext(contextOptions); await context.close(); await browser.close(); }
void useDevice;
`);
  }
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.mts', 'consumer.cts'], { cwd: consumer, encoding: 'utf8' });
  report.checks.push('Packed aliased ESM/CommonJS device declarations and ordinary spread context options');
  assert.deepEqual(await sourceManifest(), report.sources);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; throw error;
} finally {
  if (registry) { report.registryRequests = registry.requests; await registry.close(); }
  await rm(consumer, { recursive: true, force: true });
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Device catalogue evidence: ${destination}/report.json`);
}
