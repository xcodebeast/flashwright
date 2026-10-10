import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sourceManifest } from './source-manifest.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';
import { identifyBrowser } from './browser-identity.mjs';

const require = createRequire(import.meta.url);
const { utils, iso } = require('playwright-core/lib/coreBundle');
const destination = resolve(process.argv[2]);
const policies = process.argv.includes('--policies');
const interruption = process.argv.includes('--interruption');
assert(!(policies && interruption), 'choose one scenario');
await mkdir(destination, { recursive: true });
const browser = process.env.FLASHWRIGHT_BROWSER_PATH;
const driver = process.env.FLASHWRIGHT_DRIVER_PATH;
assert(browser && driver, 'explicit accepted browser and native driver are required');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', policies, interruption, ...runtimeMetadata, sources: await sourceManifest(), browser: await identifyBrowser(browser), driverSha256: digest(await readFile(driver)), attempts: [], scope: 'Private worker artifact coordinator in the actual pinned runner. Automatic public policies remain unsupported pending broader acceptance.' };
const attempts = suites => suites.flatMap(suite => [...(suite.specs ?? []).flatMap(spec => spec.tests.flatMap(test => test.results.map(result => ({ title: spec.title, project: test.projectName, expectedStatus: test.expectedStatus, ...result })))), ...attempts(suite.suites ?? [])]);
function shouldRetain(attempt) {
  if (policies && attempt.title.startsWith('static skip')) return false; // Pinned runner fast-skips this non-final test before trace startup.
  if (!policies || attempt.project === 'on') return true;
  const failed = attempt.status !== attempt.expectedStatus;
  if (attempt.project === 'retain-on-failure') return failed;
  if (attempt.project === 'on-first-retry') return attempt.retry === 1;
  if (attempt.project === 'on-all-retries') return attempt.retry > 0;
  if (attempt.project === 'retain-on-first-failure') return failed && attempt.retry === 0;
  if (attempt.project === 'retain-on-failure-and-retries') return failed || attempt.retry > 0;
  return false;
}
try {
  for (const name of ['coordinator.spec.cjs', 'coordinator-fixtures.cjs', 'policies.spec.cjs', 'interruption.spec.cjs', 'interruption-reporter.cjs', 'playwright.config.cjs']) await writeFile(join(destination, name), await readFile(`compatibility/m2/runner-artifact-coordinator/${name}`));
  const modules = resolve('packages/flashwright-runner/dist/commonjs');
  const child = spawn('python3', [resolve('tools/watchdog.py'), '--timeout', '180', '--report-directory', join(destination, 'watchdog'), '--', process.execPath, join(modules, '../upstream/cli.js'), 'test', '--config', join(destination, 'playwright.config.cjs')], {
    env: { ...process.env, FLASHWRIGHT_COORDINATOR_POLICIES: policies ? '1' : '0', FLASHWRIGHT_COORDINATOR_INTERRUPTION: interruption ? '1' : '0', FLASHWRIGHT_COORDINATOR_MODULES: modules, FLASHWRIGHT_COORDINATOR_OUTPUT: join(destination, 'output'), FLASHWRIGHT_COORDINATOR_RESULTS: join(destination, 'results.json') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  let signaled = false;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    log += bytes;
    if (interruption && !signaled && log.includes('FLASHWRIGHT_INTERRUPT_READY')) {
      const processMatch = log.match(/FLASHWRIGHT_RUNNER_PROCESS=(\d+)/);
      if (processMatch) { signaled = true; process.kill(Number(processMatch[1]), 'SIGINT'); }
    }
  });
  const exitCode = await new Promise((complete, reject) => { child.on('error', reject); child.on('close', complete); });
  await writeFile(join(destination, 'runner.log'), log);
  assert.equal(exitCode, interruption ? 130 : policies ? 1 : 0, log);
  if (interruption) assert(signaled);
  const results = JSON.parse(await readFile(join(destination, 'results.json'), 'utf8'));
  assert.equal(results.stats.expected, interruption ? 0 : policies ? 21 : 6); assert.equal(results.stats.unexpected, interruption ? 0 : policies ? 7 : 0); assert.equal(results.errors.length, 0);
  assert.equal(attempts(results.suites).length, interruption ? 1 : policies ? 63 : 6);
  for (const attempt of attempts(results.suites)) {
    if (interruption) assert.equal(attempt.status, 'interrupted');
    else if (!policies) assert.equal(attempt.status, 'passed');
    else {
      const status = attempt.expectedStatus === 'skipped' ? 'skipped' : attempt.title.startsWith('original timeout') ? 'timedOut' : attempt.title.startsWith('expected failure') || attempt.title.startsWith('flaky') && attempt.retry < 2 ? 'failed' : 'passed';
      assert.equal(attempt.status, status);
      if (status === 'failed') assert(attempt.errors.some(error => error.message.includes(attempt.title.startsWith('flaky') ? `original flaky failure ${attempt.retry}` : 'original expected failure')));
      if (status === 'timedOut') assert(attempt.errors.some(error => error.message.includes('500ms')));
    }
    assert.equal(attempt.attachments.filter(item => item.name === 'trace-error').length, 0, JSON.stringify(attempt.attachments));
    assert.equal(attempt.attachments.filter(item => item.name === 'screenshot-error').length, 0, JSON.stringify(attempt.attachments));
    const screenshots = attempt.attachments.filter(item => item.name === 'screenshot');
    const screenshotCount = policies || interruption ? Number(attempt.status !== 'skipped' && attempt.status !== attempt.expectedStatus) : attempt.project === 'native-capture' ? attempt.title.startsWith('manual') ? 3 : 1 : 0;
    assert.equal(screenshots.length, screenshotCount);
    const screenshotHashes = [];
    for (const screenshot of screenshots) {
      const bytes = await readFile(screenshot.path);
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      screenshotHashes.push(digest(bytes));
    }
    const attachments = attempt.attachments.filter(item => item.name === 'trace'); assert.equal(attachments.length, Number(shouldRetain(attempt)), `${attempt.project}: ${attempt.title} retry ${attempt.retry}`);
    if (!attachments.length) {
      report.attempts.push({ title: attempt.title, project: attempt.project, status: attempt.status, expectedStatus: attempt.expectedStatus, retry: attempt.retry, libraries: 0, screenshotHashes });
      continue;
    }
    const path = attachments[0].path;
    execFileSync('python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as archive: assert archive.testzip() is None', path]);
    const archive = new utils.ZipFile(path);
    try {
      const names = await archive.entries();
      const contents = new Map(await Promise.all(names.map(async name => [name, await archive.read(name)])));
      const libraries = names.filter(name => /^\d+-trace\.trace$/.test(name));
      assert.equal(libraries.length, attempt.status === 'skipped' ? 0 : attempt.title.startsWith('manual') ? 3 : 1);
      const loader = new iso.TraceLoader();
      await loader.load({ entryNames: async () => names, readText: async name => contents.get(name)?.toString(), hasEntry: async name => contents.has(name), isLive: () => false });
      assert.equal(loader.contextEntries.length, libraries.length + 1);
      const runner = contents.get('test.trace').toString().trim().split('\n').map(JSON.parse);
      const steps = new Map(runner.filter(event => event.type === 'before').map(event => [event.stepId, event]));
      const records = libraries.flatMap(name => contents.get(name).toString().trim().split('\n').map(JSON.parse));
      const actions = records.filter(event => event.type === 'before');
      if (attempt.status !== 'skipped') assert(actions.length > 0);
      for (const action of actions) {
        assert(steps.has(action.stepId), `${attempt.title}: missing original runner step ${action.stepId}`);
        assert.equal(steps.get(action.stepId).title, action.title);
      }
      if ((attempt.project === 'native-capture' || (policies || interruption) && attempt.project === 'on') && attempt.status !== 'skipped') assert(records.some(event => event.type === 'frame-snapshot'));
      assert.equal(names.some(name => name.startsWith('resources/src@')), !policies && !interruption);
      report.attempts.push({ title: attempt.title, project: attempt.project, status: attempt.status, expectedStatus: attempt.expectedStatus, retry: attempt.retry, archiveSha256: digest(await readFile(path)), libraries: libraries.length, actions: actions.length, entries: names.length, screenshotHashes });
    } finally { archive.close(); }
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally { await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ status: report.status, attempts: report.attempts, error: report.error })); }
