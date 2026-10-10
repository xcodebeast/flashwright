import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { join, resolve, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { identifyBrowser } from './browser-identity.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';
import { packConsumerPackages } from './packed-artifacts.mjs';
import { startConsumerRegistry } from './consumer-registry.mjs';
import { requireBun } from './bun-toolchain.mjs';

const require = createRequire(import.meta.url);
const { utils, iso } = require('playwright-core/lib/coreBundle');
const packed = process.argv.includes('--packed');
const destination = resolve(process.argv.slice(2).find(argument => !argument.startsWith('--')));
await mkdir(destination, { recursive: true });
const browser = process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath();
const driver = process.env.FLASHWRIGHT_DRIVER_PATH ?? resolve('target/debug/flashwright-driver');
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const report = { status: 'running', ...runtimeMetadata, sources: await sourceManifest(), browser: await identifyBrowser(browser), driverSha256: hash(await readFile(driver)), attempts: [], scope: 'Private action-bound native recordings use the production finalizer collection boundary and original source-only journal in the actual owned runner; public automatic tracing remains unsupported.' };
const attempts = suites => suites.flatMap(suite => [...(suite.specs ?? []).flatMap(spec => spec.tests.flatMap(test => test.results.map(result => ({ title: spec.title, project: test.projectName, ...result })))), ...attempts(suite.suites ?? [])]);
let consumer;
let registry;
try {
  if (packed) {
    const { archives } = await packConsumerPackages(destination, { runner: true });
    report.artifacts = Object.fromEntries(await Promise.all(Object.entries(archives).map(async ([name, path]) => [name, { path, sha256: hash(await readFile(path)) }])));
    consumer = await realpath(await mkdtemp(join(tmpdir(), 'flashwright-source-packed-')));
    registry = await startConsumerRegistry(Object.values(archives));
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'source-packed-consumer', private: true, dependencies: { '@flashwright/test': '0.0.0', flashwright: '0.0.0' } }));
    const installing = spawn(requireBun(), ['install', '--ignore-scripts', '--omit=optional', '--omit=peer', '--registry', registry.url], { cwd: consumer, env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(consumer, 'cache') } });
    let output = ''; for (const stream of [installing.stdout, installing.stderr]) stream.on('data', bytes => { output += bytes; });
    const exitCode = await new Promise((complete, reject) => { installing.on('error', reject); installing.on('close', complete); });
    await writeFile(join(destination, 'install.log'), output); assert.equal(exitCode, 0, output);
    report.installedCompiledFiles = {};
    for (const [name, paths] of Object.entries({ 'flashwright-core': ['tracing.js', 'trace-archive-assembly.js'], 'flashwright-runner': ['runner-trace-finalizer.js', 'runner-trace-journal.js', 'trace-steps.js'] })) {
      const packageDirectory = dirname(createRequire(join(consumer, 'package.json')).resolve(`@flashwright/${name.slice('flashwright-'.length)}/package.json`));
      for (const path of paths) {
        const source = `packages/${name}/dist/commonjs/${path}`;
        const actual = hash(await readFile(join(packageDirectory, 'dist/commonjs', path)));
        assert.equal(actual, hash(await readFile(source)), `packed consumer has current ${path}`);
        report.installedCompiledFiles[source] = actual;
      }
    }
  }
  const workingDirectory = consumer ?? process.cwd();
  const fixtureDirectory = consumer ? join(consumer, 'tests') : destination;
  await mkdir(fixtureDirectory, { recursive: true });
  for (const name of ['sources.spec.cjs', 'source-helper.cjs', 'playwright.config.cjs']) await writeFile(join(fixtureDirectory, name), await readFile(`compatibility/m2/runner-trace-sources/${name}`));
  const modules = consumer ? join(dirname(createRequire(join(consumer, 'package.json')).resolve('@flashwright/runner/package.json')), 'dist/commonjs') : resolve('packages/flashwright-runner/dist/commonjs');
  const child = spawn('python3', [resolve('tools/watchdog.py'), '--timeout', '120', '--report-directory', join(destination, 'watchdog'), '--', process.execPath, join(modules, '../upstream/cli.js'), 'test', '--config', join(fixtureDirectory, 'playwright.config.cjs')], {
    cwd: workingDirectory, env: { ...process.env, FLASHWRIGHT_SOURCE_MODULES: modules, FLASHWRIGHT_SOURCE_OUTPUT: join(destination, 'output'), FLASHWRIGHT_SOURCE_RESULTS: join(destination, 'results.json'), FLASHWRIGHT_SOURCE_EVENTS: join(destination, 'events.jsonl'), FLASHWRIGHT_BROWSER_PATH: browser, FLASHWRIGHT_DRIVER_PATH: driver }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; });
  const exitCode = await new Promise((complete, reject) => { child.on('error', reject); child.on('close', complete); });
  await writeFile(join(destination, 'runner.log'), log); assert.equal(exitCode, 0, log);
  const results = JSON.parse(await readFile(join(destination, 'results.json'), 'utf8'));
  assert.equal(results.stats.expected, 6); assert.equal(results.stats.unexpected, 0); assert.equal(results.errors.length, 0);
  const reads = (await readFile(join(destination, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  for (const attempt of attempts(results.suites)) {
    assert.equal(attempt.status, 'passed');
    assert.equal(attempt.attachments.filter(item => item.name === 'trace-error').length, 0);
    const attachments = attempt.attachments.filter(item => item.name === 'trace'); assert.equal(attachments.length, 1);
    const path = attachments[0].path;
    execFileSync('python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as archive: assert archive.testzip() is None', path]);
    const zip = new utils.ZipFile(path);
    try {
      const names = await zip.entries();
      const contents = new Map(await Promise.all(names.map(async name => [name, await zip.read(name)])));
      const loader = new iso.TraceLoader();
      await loader.load({ entryNames: async () => names, readText: async name => contents.get(name)?.toString(), hasEntry: async name => contents.has(name), isLive: () => false });
      const libraries = names.filter(name => /^\d+-trace\.trace$/.test(name));
      assert.equal(libraries.length, attempt.title.startsWith('reused') ? 2 : 1);
      assert.equal(loader.contextEntries.length, libraries.length + 1);
      const runner = contents.get('test.trace').toString().trim().split('\n').map(JSON.parse);
      const runnerSteps = new Map(runner.filter(event => event.type === 'before').map(event => [event.stepId, event]));
      const actions = libraries.flatMap(name => contents.get(name).toString().trim().split('\n').map(JSON.parse).filter(event => event.type === 'before'));
      assert(actions.length > 0);
      for (const action of actions) {
        assert.ok(runnerSteps.has(action.stepId), `${attempt.title}: original step ${action.stepId}`);
        assert.equal(runnerSteps.get(action.stepId).title, action.title, `${attempt.title}: step identity retains its original title`);
        const parent = runnerSteps.get(action.stepId).parentId;
        if (parent) assert.ok(runnerSteps.has(parent), `${attempt.title}: parent belongs to original runner journal`);
      }
      const originalReads = reads.find(item => item.title === attempt.title && item.project === attempt.project).reads;
      const helper = join(fixtureDirectory, 'source-helper.cjs');
      if (attempt.project === 'sources-on') {
        assert.equal(originalReads.filter(path => path === helper).length, 1);
        assert.deepEqual(contents.get(`resources/src@${hash(helper, 'sha1')}.txt`), Buffer.from((await readFile(helper)).toString('utf8')));
      } else {
        assert.deepEqual(originalReads, []);
        assert(!names.some(name => name.startsWith('resources/')));
      }
      const model = new iso.TraceModel('owned-source-bridge', loader.contextEntries);
      assert(model.actions.length > 0);
      report.attempts.push({ title: attempt.title, project: attempt.project, archive: path, sha256: hash(await readFile(path)), libraryChunks: libraries.length, libraryActions: actions.length, sourceReads: originalReads.map(path => basename(path)), viewerActions: model.actions.length });
    } finally { zip.close(); }
  }
  assert.equal(report.attempts.length, 6);
  assert.deepEqual(await sourceManifest(), report.sources); assert.equal(hash(await readFile(driver)), report.driverSha256); assert.equal(hash(await readFile(browser)), report.browser.sha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  await registry?.close();
  if (consumer) await rm(consumer, { recursive: true, force: true });
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ status: report.status, attempts: report.attempts.length, error: report.error }));
}
