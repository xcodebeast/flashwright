import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { chromium } from 'playwright';
import { identifyBrowser } from './browser-identity.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';

const require = createRequire(import.meta.url);
const { utils, iso } = require('playwright-core/lib/coreBundle');
const destination = resolve(process.argv[2]);
await mkdir(destination, { recursive: true });
for (const name of ['sources.spec.cjs', 'source-helper.cjs', 'playwright.config.cjs']) await writeFile(join(destination, name), await readFile(`compatibility/m2/runner-trace-sources/${name}`));
const browser = process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath();
const driver = process.env.FLASHWRIGHT_DRIVER_PATH ?? resolve('target/debug/flashwright-driver');
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const report = { status: 'running', ...runtimeMetadata, sources: await sourceManifest(), browser: await identifyBrowser(browser), driverSha256: hash(await readFile(driver)), attempts: [], scope: 'Private action-bound native recording and source-only journal assembly in the actual owned runner; public automatic tracing remains unsupported.' };
const attempts = suites => suites.flatMap(suite => [...(suite.specs ?? []).flatMap(spec => spec.tests.flatMap(test => test.results.map(result => ({ title: spec.title, project: test.projectName, ...result })))), ...attempts(suite.suites ?? [])]);
try {
  const child = spawn('python3', ['tools/watchdog.py', '--timeout', '120', '--report-directory', join(destination, 'watchdog'), '--', process.execPath, resolve('packages/flashwright-runner/dist/upstream/cli.js'), 'test', '--config', join(destination, 'playwright.config.cjs')], {
    env: { ...process.env, FLASHWRIGHT_SOURCE_MODULES: resolve('packages/flashwright-runner/dist/commonjs'), FLASHWRIGHT_SOURCE_OUTPUT: join(destination, 'output'), FLASHWRIGHT_SOURCE_RESULTS: join(destination, 'results.json'), FLASHWRIGHT_SOURCE_EVENTS: join(destination, 'events.jsonl'), FLASHWRIGHT_BROWSER_PATH: browser, FLASHWRIGHT_DRIVER_PATH: driver }, stdio: ['ignore', 'pipe', 'pipe'],
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
      const helper = join(destination, 'source-helper.cjs');
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
finally { await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ status: report.status, attempts: report.attempts.length, error: report.error })); }
