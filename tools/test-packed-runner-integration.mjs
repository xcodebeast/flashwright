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

const destination = resolve(`compatibility/evidence/runner-integration-packed-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(destination, { recursive: true });
const consumer = await mkdtemp(join(tmpdir(), 'flashwright-runner-integration-packed-'));
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
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'runner-integration-packed-consumer', private: true, type: 'module', dependencies: { '@flashwright/core': '0.0.0', flashwright: '0.0.0', playwright: 'npm:flashwright@0.0.0', '@types/node': '24.10.1' } }, null, 2));
  const child = spawn(requireBun(), ['install', '--ignore-scripts', '--omit=optional', '--omit=peer', '--registry', registry.url], { cwd: consumer, env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(consumer, 'cache') } });
  let install = '';
  child.stdout.on('data', bytes => { install += bytes; });
  child.stderr.on('data', bytes => { install += bytes; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  await writeFile(join(destination, 'install.log'), install);
  assert.equal(code, 0, install);
  await writeFile(join(consumer, 'identity.mjs'), `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runnerIntegration } from '@flashwright/core/runner-integration';
import * as direct from 'flashwright';
import * as aliased from 'playwright';
const require = createRequire(import.meta.url);
assert.equal(runnerIntegration, require('@flashwright/core/runner-integration').runnerIntegration);
assert.equal(direct.chromium, aliased.chromium);
assert.equal(direct.chromium, require('flashwright').chromium);
assert.equal(aliased.chromium, require('playwright').chromium);
assert.equal('runnerIntegration' in direct, false);
assert.equal('runnerIntegration' in aliased, false);
assert.equal(runnerIntegration.version, 5);
assert.throws(() => runnerIntegration.createTraceJournal(4, {}, { sources:false, attachments:false }), error => error.name === 'ProtocolError');
const journal = await runnerIntegration.createTraceJournal(5, { version:8, type:'context-options', origin:'testRunner' }, { sources:false, attachments:true });
journal.append({ type:'after', callId:'packed', endTime:1 }, [{ name:'body', contentType:'text/plain', body:Buffer.from('packed body') }]);
const journalArchive = await journal.takeArchive(1000, new AbortController().signal);
await journal.dispose();
const journalReader = journalArchive.acquire();
assert.equal(journalReader.entries[0].name, 'test.trace');
assert.equal(journalReader.entries.length, 2);
journalReader.release();
await journalArchive.dispose();
assert.throws(() => runnerIntegration.createTraceArchiveAssembly(3), error => error.name === 'ProtocolError');
const assembly = runnerIntegration.createTraceArchiveAssembly(4);
await assembly.dispose();
assert.equal(typeof runnerIntegration.currentTraceChunk, 'function');
assert.throws(() => runnerIntegration.currentTraceChunk(2, {}), error => error.name === 'ProtocolError');
assert.throws(() => runnerIntegration.currentTraceChunk(3, {}), error => error.name === 'ProtocolError');
for (const library of [direct, aliased, require('flashwright'), require('playwright')]) {
  for (const method of ['reload', 'goBack', 'goForward', 'waitForNavigation', 'waitForURL']) assert.equal(typeof library.Page.prototype[method], 'function');
  assert.equal(library.Tracing, direct.Tracing);
  assert.equal(library.BrowserContext, direct.BrowserContext);
  assert.equal(typeof Object.getOwnPropertyDescriptor(library.BrowserContext.prototype, 'tracing').get, 'function');
  for (const method of ['start', 'startChunk', 'stopChunk', 'stop']) assert.equal(typeof library.Tracing.prototype[method], 'function');
}
assert.equal(runnerIntegration.runInternal(1, () => direct.chromium), direct.chromium);
assert.throws(() => runnerIntegration.runInternal(2, () => {}), error => error.name === 'ProtocolError');
const removeMapper = runnerIntegration.installSourcePositionMapper(1, position => position);
assert.throws(() => require('@flashwright/core/runner-integration').runnerIntegration.installSourcePositionMapper(1, position => position), error => error.name === 'ProtocolError');
removeMapper();
assert.throws(() => runnerIntegration.installSourcePositionMapper(2, position => position), error => error.name === 'ProtocolError');
const defaults = { contextOptions:{ baseURL:'http://packed.invalid' }, actionTimeout:10, navigationTimeout:20 };
const removeLifecycle = runnerIntegration.installContextLifecycle(1, { didCreateContext() {}, async willCloseContext() {} });
assert.throws(() => require('@flashwright/core/runner-integration').runnerIntegration.installContextLifecycle(1, { didCreateContext() {}, async willCloseContext() {} }), error => error.name === 'ProtocolError');
removeLifecycle();
const release = runnerIntegration.installContextDefaults(1, defaults);
assert.throws(() => require('@flashwright/core/runner-integration').runnerIntegration.installContextDefaults(1, defaults), error => error.name === 'ProtocolError');
release();
const releaseAgain = require('@flashwright/core/runner-integration').runnerIntegration.installContextDefaults(1, defaults);
releaseAgain();
assert.throws(() => runnerIntegration.installContextDefaults(2, defaults), error => error.name === 'ProtocolError');
console.log(JSON.stringify({ mixedIdentity:true, sharedScope:true, versionEnforced:true, publicFacadeClean:true }));
`);
  const runtime = JSON.parse(execFileSync(process.execPath, ['identity.mjs'], { cwd: consumer, encoding: 'utf8' }));
  report.checks.push(runtime);
  for (const extension of ['mts', 'cts']) {
    await writeFile(join(consumer, `consumer.${extension}`), `import { runnerIntegration } from '@flashwright/core/runner-integration';
import { chromium, type Page, type Response, type NavigationWaitOptions, type WaitForNavigationOptions, type BrowserContext, type Tracing, type TracingStartOptions, type TracingChunkOptions, type TracingStopOptions } from 'playwright';
import type { Page as DirectPage } from 'flashwright';
async function history(page: Page, directPage: DirectPage) {
  const options: NavigationWaitOptions = { waitUntil: 'commit', timeout: 1000 };
  const responses: Array<Response | null> = [await page.reload(options), await page.goBack(), await page.goForward(), await directPage.reload(options)];
  const waiting: WaitForNavigationOptions = { url: '**/next', timeout: 1000, waitUntil: 'load' };
  const navigation: Response | null = await page.waitForNavigation(waiting);
  const nothing: void = await directPage.waitForURL('/next');
  return { responses, navigation, nothing };
}
void history;
async function manualTrace(context: BrowserContext) {
  const tracing: Tracing = context.tracing;
  const start: TracingStartOptions = { title: 'Packed trace', screenshots: false, snapshots: false, sources: false };
  const chunk: TracingChunkOptions = { name: 'chunk', title: 'Packed chunk' };
  const stop: TracingStopOptions = { path: 'trace.zip' };
  await tracing.start(start);
  await tracing.stopChunk(stop);
  await tracing.startChunk(chunk);
  await tracing.stop(stop);
}
async function runnerArchive(context: BrowserContext) {
  const chunk = runnerIntegration.currentTraceChunk(3, context.tracing);
  if (!chunk) return;
  const archive = await chunk.takeArchive(new AbortController().signal);
  const reader = archive.acquire();
  const names: readonly string[] = reader.entries.map(entry => entry.name);
  reader.release();
  await archive.dispose();
  return names;
}
void runnerArchive;
async function runnerAssembly(context: BrowserContext) {
  const archive = await runnerIntegration.currentTraceChunk(3, context.tracing)?.takeArchive();
  const assembly = runnerIntegration.createTraceArchiveAssembly(4);
  if (archive) {
    assembly.addLibrary(archive);
    const combined = assembly.seal();
    await combined.dispose();
  }
  await assembly.dispose();
}
void runnerAssembly;
async function runnerJournal() {
  const journal = await runnerIntegration.createTraceJournal(5, { version:8, type:'context-options', origin:'testRunner' }, { sources:true, attachments:true });
  journal.append({ type:'before', callId:'packed' });
  journal.appendStdio('stdout', Buffer.from('packed output'), 1);
  const archive = await journal.takeArchive(1000, new AbortController().signal);
  const assembly = runnerIntegration.createTraceArchiveAssembly(4);
  assembly.addRunner(archive);
  const combined = assembly.seal();
  await journal.dispose();
  await assembly.dispose();
  await combined.dispose();
}
void runnerJournal;
void manualTrace;
const internal: number = runnerIntegration.runInternal(1, () => 1);
void internal;
const removeMapper = runnerIntegration.installSourcePositionMapper(1, position => ({ source: position.source, line: position.line, column: position.column }));
removeMapper();
const restore = runnerIntegration.installContextDefaults(1, { contextOptions:{ baseURL:'http://types.invalid', hasTouch:false }, actionTimeout:10, navigationTimeout:20 });
restore();
const removeLifecycle = runnerIntegration.installContextLifecycle(1, { didCreateContext(context) { context.pages(); }, async willCloseContext(context) { context.pages(); } });
removeLifecycle();
void chromium;
`);
  }
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.mts', 'consumer.cts'], { cwd: consumer, encoding: 'utf8' });
  report.checks.push('Packed aliased ESM/CommonJS runner boundary, navigation and manual-tracing declarations, canonical identity and version enforcement');
  assert.deepEqual(await sourceManifest(), report.sources);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; throw error;
} finally {
  if (registry) { report.registryRequests = registry.requests; await registry.close(); }
  await rm(consumer, { recursive: true, force: true });
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Runner integration packed evidence: ${destination}/report.json`);
}
