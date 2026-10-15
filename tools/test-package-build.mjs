import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { compilePackage } from './package-compiler.mjs';
import { preparePackageBuild } from './incremental-package-build.mjs';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(join(repository, 'workbench'), { recursive: true });
const directory = await mkdtemp(join(repository, 'workbench/package-build-tests-'));
const fixture = join(directory, 'fixture');
const lateInputFixture = join(directory, `late-input-${basename(directory)}`);
const lateInputState = resolve('workbench/package-build-state', basename(lateInputFixture));
const packages = ['flashwright-core', 'flashwright-runner', 'flashwright', 'flashwright-test'];
const observations = [];
const write = async (name, contents) => {
  await mkdir(dirname(join(fixture, name)), { recursive: true });
  await writeFile(join(fixture, name), contents);
};
for (const name of ['tsconfig.json', 'package.json', 'compatibility/upstream', ...packages.map(name => `packages/${name}`), 'packages/resident-runtime',
  'tools/build-packages.mjs', 'tools/build-runner-runtime.mjs', 'tools/incremental-package-build.mjs', 'tools/package-compiler.mjs']) {
  await cp(join(repository, name), join(fixture, name), { recursive: true, filter: source => !source.split('/').some(part => part === 'dist' || part === 'node_modules') });
}
await mkdir(join(fixture, 'node_modules/@flashwright'), { recursive: true });
for (const name of await readdir(join(repository, 'node_modules'))) {
  if (name === '@flashwright' || name === 'flashwright') continue;
  await symlink(join(repository, 'node_modules', name), join(fixture, 'node_modules', name));
}
for (const [name, target] of [['@flashwright/core', 'flashwright-core'], ['@flashwright/runner', 'flashwright-runner'], ['@flashwright/test', 'flashwright-test'], ['flashwright', 'flashwright']]) {
  await symlink(join(fixture, 'packages', target), join(fixture, 'node_modules', name));
}

async function build(label, { clean = false, succeeds = true } = {}) {
  const started = performance.now();
  const child = spawn(process.execPath, ['tools/build-packages.mjs', ...(clean ? ['--clean'] : [])], {
    cwd: fixture, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let failure;
  const stop = error => {
    failure ??= error;
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const interrupt = () => stop(new Error(`${label}: interrupted by SIGINT`));
  const terminate = () => stop(new Error(`${label}: interrupted by SIGTERM`));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  const timeout = setTimeout(() => stop(new Error(`${label}: package build exceeded 180 seconds`)), 180_000);
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      output += chunk;
      if (output.length > 4 * 1024 * 1024) stop(new Error(`${label}: excessive compiler output`));
    });
  }
  const exitCode = await new Promise(resolve => {
    child.once('error', error => { failure = error; });
    child.once('close', code => { clearTimeout(timeout); resolve(code); });
  });
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
  observations.push({ label, seconds: (performance.now() - started) / 1000, exitCode });
  await writeFile(join(directory, `${label}.log`), output);
  assert.ifError(failure);
  assert.equal(exitCode === 0, succeeds, `${label}: ${output}`);
  console.log(`Package build control passed: ${label}`);
}

async function inventory(path, prefix = '') {
  const files = {};
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(files, await inventory(join(path, entry.name), name + '/'));
    else files[name] = createHash('sha256').update(await readFile(join(path, entry.name))).digest('hex');
  }
  return files;
}

async function packageInventory() {
  const result = {};
  for (const name of packages) result[name] = await inventory(join(fixture, 'packages', name, 'dist'));
  return result;
}

try {
  await mkdir(lateInputFixture);
  const lateSource = join(lateInputFixture, 'source.ts');
  await writeFile(join(lateInputFixture, 'tsconfig.json'), JSON.stringify({ compilerOptions: { types: [] }, files: ['source.ts'] }));
  const firstSource = 'export const value = 1;\n';
  await writeFile(lateSource, firstSource);
  const originalBuild = await preparePackageBuild(lateInputFixture, { clean: true });
  await originalBuild.compile();
  await writeFile(lateSource, 'export const value = 2;\n');
  await originalBuild.complete();
  const originalReceipt = JSON.parse(await readFile(join(lateInputState, 'outputs.json'), 'utf8'));
  const capturedSource = originalReceipt.compilerInputs.find(operation => operation.method === 'readFile' && resolve(operation.arguments[0]) === lateSource);
  assert.equal(capturedSource.value, createHash('sha256').update(firstSource).digest('hex'), 'Publication refreshed compiler-owned inputs');
  const originalOutput = await readFile(join(lateInputFixture, 'dist/commonjs/source.js'), 'utf8');
  assert.match(originalOutput, /value = 1/);
  const changedBuild = await preparePackageBuild(lateInputFixture);
  await changedBuild.compile();
  await changedBuild.complete();
  assert.match(await readFile(join(lateInputFixture, 'dist/commonjs/source.js'), 'utf8'), /value = 2/);
  await rm(lateInputFixture, { recursive: true });
  await rm(lateInputState, { recursive: true });

  const concurrentFixture = join(directory, 'concurrent-input');
  await mkdir(concurrentFixture);
  const concurrentSource = join(concurrentFixture, 'source.ts');
  const concurrentConfiguration = join(concurrentFixture, 'tsconfig.json');
  await writeFile(concurrentSource, 'export const value = 1;\n');
  await writeFile(concurrentConfiguration, JSON.stringify({ compilerOptions: { types: [] }, files: ['source.ts'] }));
  const typescript = createRequire(import.meta.url)('typescript');
  let sourceChanged = false;
  assert.throws(() => compilePackage(concurrentConfiguration, join(concurrentFixture, 'output'), {
    ...typescript.sys,
    readFile(path, encoding) {
      const contents = typescript.sys.readFile(path, encoding);
      if (resolve(path) === concurrentSource && !sourceChanged) {
        sourceChanged = true;
        writeFileSync(concurrentSource, 'export const value = 2;\n');
      }
      return contents;
    },
  }), /Compiler input changed/);
  assert.ok(sourceChanged, 'Concurrent-edit control did not reach the compiler read');
  await rm(concurrentFixture, { recursive: true });

  await build('clean', { clean: true });
  const baseline = await packageInventory();
  const emitted = join(fixture, 'packages/flashwright-core/dist/commonjs/errors.js');
  const originalTimestamp = (await stat(emitted, { bigint: true })).mtimeNs;
  await build('unchanged');
  assert.deepEqual(await packageInventory(), baseline);
  assert.equal((await stat(emitted, { bigint: true })).mtimeNs, originalTimestamp, 'Unchanged compiler output was rewritten');

  const matchers = await readFile(join(fixture, 'packages/flashwright-runner/src/matchers.ts'), 'utf8');
  assert.ok(matchers.includes('isPageAssertion'), 'Declaration-map regression needs the original private identifier');
  await write('packages/flashwright-runner/src/matchers.ts', matchers.replaceAll('isPageAssertion', 'usesPageAssertion'));
  await build('inferred-type-source-position');
  const movedTypePositions = await packageInventory();
  assert.notEqual(movedTypePositions['flashwright-runner']['commonjs/index.d.ts.map'], baseline['flashwright-runner']['commonjs/index.d.ts.map']);
  await build('inferred-type-position-clean-equivalence', { clean: true });
  assert.deepEqual(await packageInventory(), movedTypePositions, 'Incremental declaration maps differ from clean emission');
  await write('packages/flashwright-runner/src/matchers.ts', matchers);
  await build('inferred-type-position-restored');
  assert.deepEqual(await packageInventory(), baseline);

  await rm(emitted);
  await build('missing-output');
  assert.deepEqual(await packageInventory(), baseline);
  await write('packages/flashwright-core/dist/commonjs/errors.js', 'damaged output');
  await build('damaged-output');
  assert.deepEqual(await packageInventory(), baseline);
  await write('packages/flashwright-runner/dist/commonjs/stale.js', 'unexpected output');
  await build('unexpected-output');
  assert.deepEqual(await packageInventory(), baseline);
  await write('workbench/package-build-state/flashwright-core/outputs.json', '{}');
  await build('damaged-compiler-state');
  assert.deepEqual(await packageInventory(), baseline);

  await write('packages/flashwright-core/src/build-probe.ts', 'export const value: number = 1;\n');
  await build('added-source');
  const firstAdded = await packageInventory();
  assert.ok(firstAdded['flashwright-core']['commonjs/build-probe.js']);
  await write('packages/flashwright-core/src/build-probe.ts', 'export const value: number = 2;\n');
  await build('changed-implementation');
  const changed = await packageInventory();
  assert.notEqual(changed['flashwright-core']['commonjs/build-probe.js'], firstAdded['flashwright-core']['commonjs/build-probe.js']);
  await build('changed-clean-equivalence', { clean: true });
  assert.deepEqual(await packageInventory(), changed);
  await rm(join(fixture, 'packages/flashwright-core/src/build-probe.ts'));
  await build('removed-source');
  assert.deepEqual(await packageInventory(), baseline);

  await write('packages/flashwright-core/src/build-probe/nested.ts', 'export const nested = 1;\n');
  await build('nested-source');
  await rename(join(fixture, 'packages/flashwright-core/src/build-probe/nested.ts'), join(fixture, 'packages/flashwright-core/src/build-probe/renamed.ts'));
  await build('nested-source-renamed');
  const renamed = await packageInventory();
  assert.ok(renamed['flashwright-core']['commonjs/build-probe/renamed.js']);
  assert.ok(!Object.keys(renamed['flashwright-core']).some(name => name.startsWith('commonjs/build-probe/nested.')));
  await rm(join(fixture, 'packages/flashwright-core/src/build-probe'), { recursive: true });
  await build('nested-source-removed');
  assert.deepEqual(await packageInventory(), baseline);

  await write('node_modules/build-probe/entry/index.d.ts', 'export const value: number;\n');
  await write('packages/flashwright-core/src/build-probe.ts', 'import { value } from "build-probe/entry";\nexport const probe: number = value;\n');
  await build('resolution-fallback');
  await write('node_modules/build-probe/entry.d.ts', 'export const value: string;\n');
  await build('previously-missing-resolution-candidate', { succeeds: false });
  await rm(join(fixture, 'node_modules/build-probe'), { recursive: true });
  await rm(join(fixture, 'packages/flashwright-core/src/build-probe.ts'));
  await build('resolution-recovery');
  assert.deepEqual(await packageInventory(), baseline);

  await write('packages/flashwright-core/src/build-probe.ts', 'export const value: number = "invalid";\n');
  await build('type-error', { succeeds: false });
  await assert.rejects(readFile(join(fixture, 'workbench/package-build-state/flashwright-core/outputs.json')), { code: 'ENOENT' });
  await rm(join(fixture, 'packages/flashwright-core/src/build-probe.ts'));
  await build('type-error-recovery');
  assert.deepEqual(await packageInventory(), baseline);

  const coreIndex = await readFile(join(fixture, 'packages/flashwright-core/src/index.ts'), 'utf8');
  await write('packages/flashwright-core/src/index.ts', coreIndex + '\nexport interface BuildProbe { value: number }\n');
  await write('packages/flashwright-runner/src/build-probe.ts', 'import type { BuildProbe } from "@flashwright/core";\nexport const probe: BuildProbe = { value: 1 };\n');
  await build('cross-package-type');
  await write('packages/flashwright-core/src/index.ts', coreIndex + '\nexport interface BuildProbe { value: string }\n');
  await build('changed-dependency-type', { succeeds: false });
  await write('packages/flashwright-core/src/index.ts', coreIndex);
  await rm(join(fixture, 'packages/flashwright-runner/src/build-probe.ts'));
  await build('dependency-type-recovery');
  assert.deepEqual(await packageInventory(), baseline);

  const configuration = JSON.parse(await readFile(join(fixture, 'packages/flashwright-core/tsconfig.json'), 'utf8'));
  configuration.compilerOptions.removeComments = true;
  await write('packages/flashwright-core/tsconfig.json', JSON.stringify(configuration));
  await build('compiler-option-change');
  const configured = await packageInventory();
  assert.notDeepEqual(configured, baseline);
  await build('compiler-option-clean-equivalence', { clean: true });
  assert.deepEqual(await packageInventory(), configured);

  const originalRootConfiguration = await readFile(join(fixture, 'tsconfig.json'), 'utf8');
  const rootConfiguration = JSON.parse(originalRootConfiguration);
  rootConfiguration.compilerOptions.removeComments = true;
  delete configuration.compilerOptions.removeComments;
  configuration.compilerOptions.sourceMap = false;
  configuration.compilerOptions.inlineSources = false;
  configuration.compilerOptions.declarationMap = false;
  await write('tsconfig.json', JSON.stringify(rootConfiguration));
  await write('packages/flashwright-core/tsconfig.json', JSON.stringify(configuration));
  await build('inherited-option-without-maps');
  const withoutMaps = await packageInventory();
  assert.ok(!Object.keys(withoutMaps['flashwright-core']).some(name => name.endsWith('.map')));
  await build('inherited-option-clean-equivalence', { clean: true });
  assert.deepEqual(await packageInventory(), withoutMaps);
  configuration.compilerOptions.sourceMap = true;
  configuration.compilerOptions.inlineSources = true;
  configuration.compilerOptions.declarationMap = true;
  await write('tsconfig.json', originalRootConfiguration);
  await write('packages/flashwright-core/tsconfig.json', JSON.stringify(configuration));
  await build('maps-restored');
  assert.deepEqual(await packageInventory(), baseline);

  const runtimeVersion = await readFile(join(fixture, 'packages/flashwright-core/dist/commonjs/runtime-version.cjs'), 'utf8');
  const serialization = await readFile(join(fixture, 'packages/resident-runtime/serialization.cjs'), 'utf8');
  await write('packages/resident-runtime/serialization.cjs', serialization + '\n// Build input change.\n');
  await build('resident-runtime-change');
  assert.notEqual(await readFile(join(fixture, 'packages/flashwright-core/dist/commonjs/runtime-version.cjs'), 'utf8'), runtimeVersion);
  assert.equal(await readFile(join(fixture, 'packages/flashwright-core/dist/commonjs/serialization.cjs'), 'utf8'), serialization + '\n// Build input change.\n');

  const hooks = await readFile(join(fixture, 'packages/flashwright-runner/runner-hooks.cjs'), 'utf8');
  await write('packages/flashwright-runner/runner-hooks.cjs', hooks + '\n// Copied input change.\n');
  await build('runner-hook-change');
  assert.equal(await readFile(join(fixture, 'packages/flashwright-runner/dist/upstream/flashwright-hooks.cjs'), 'utf8'), hooks + '\n// Copied input change.\n');

  const notice = join(fixture, 'compatibility/upstream/LICENSE.mime');
  const originalNotice = await readFile(notice);
  await rm(notice);
  await build('post-compilation-failure', { succeeds: false });
  await assert.rejects(readFile(join(fixture, 'workbench/package-build-state/flashwright-core/outputs.json')), { code: 'ENOENT' });
  await writeFile(notice, originalNotice);
  await build('post-compilation-recovery');
  const recovered = await packageInventory();
  await build('recovery-clean-equivalence', { clean: true });
  assert.deepEqual(await packageInventory(), recovered);

  await writeFile(join(directory, 'report.json'), JSON.stringify({ status: 'passed', changedDuringCompilerReadRejected: true, changedAfterCompilerExitRebuilt: true, runtime: process.versions.bun ?? process.version, observations, baselineOutputFiles: Object.values(baseline).reduce((count, files) => count + Object.keys(files).length, 0) }, null, 2));
  console.log(`Package build controls passed: ${directory}`);
} finally {
  // Logs and measurements survive; the owned source copy, outputs and dependency links do not.
  await rm(fixture, { recursive: true, force: true });
  await rm(lateInputFixture, { recursive: true, force: true });
  await rm(lateInputState, { recursive: true, force: true });
}
