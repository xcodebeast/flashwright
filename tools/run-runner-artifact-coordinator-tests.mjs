import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { packConsumerPackages } from './packed-artifacts.mjs';
import { startConsumerRegistry } from './consumer-registry.mjs';
import { requireBun } from './bun-toolchain.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';
import { identifyBrowser } from './browser-identity.mjs';

const require = createRequire(import.meta.url);
const { utils, iso } = require('playwright-core/lib/coreBundle');
const destination = resolve(process.argv[2]);
const api = process.argv.includes('--api');
const policies = process.argv.includes('--policies');
const interruption = process.argv.includes('--interruption');
const publicFixtures = process.argv.includes('--fixtures');
const packed = process.argv.includes('--packed');
const publicRunner = packed || process.argv.includes('--public');
assert(Number(api) + Number(policies) + Number(interruption) + Number(publicFixtures) <= 1, 'choose one scenario');
assert(!api || !packed, 'private API admission is not a packed public capability');
assert(!publicFixtures || publicRunner, 'stock fixtures require the public runner');
await mkdir(destination, { recursive: true });
const browser = process.env.FLASHWRIGHT_BROWSER_PATH;
const driver = process.env.FLASHWRIGHT_DRIVER_PATH;
assert(browser && driver, 'explicit accepted browser and native driver are required');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', api, policies, interruption, publicRunner, publicFixtures, packed, ...runtimeMetadata, sources: await sourceManifest(), browser: await identifyBrowser(browser), driverSha256: digest(await readFile(driver)), attempts: [], scope: publicRunner ? 'Public runner automatic artifacts through the original worker coordinator.' : 'Private worker artifact coordinator in the actual pinned runner.' };
const attempts = suites => suites.flatMap(suite => [...(suite.specs ?? []).flatMap(spec => spec.tests.flatMap(test => test.results.map(result => ({ title: spec.title, project: test.projectName, expectedStatus: test.expectedStatus, ...result })))), ...attempts(suite.suites ?? [])]);
function shouldRetain(attempt) {
  if (attempt.title.startsWith('pending module publication')) return false;
  if (policies && attempt.title.startsWith('static skip')) return false; // Pinned runner fast-skips this non-final test before trace startup.
  if (!policies || attempt.project === 'on') return true;
  const failed = attempt.status !== attempt.expectedStatus;
  if (attempt.project === 'retain-on-failure') return failed;
  if (['on-first-retry', 'retry-with-trace'].includes(attempt.project)) return attempt.retry === 1;
  if (attempt.project === 'on-all-retries') return attempt.retry > 0;
  if (attempt.project === 'retain-on-first-failure') return failed && attempt.retry === 0;
  if (attempt.project === 'retain-on-failure-and-retries') return failed || attempt.retry > 0;
  return false;
}
let consumer;
let registry;
try {
  if (packed) {
    const { archives } = await packConsumerPackages(destination, { runner: true });
    report.artifacts = Object.fromEntries(await Promise.all(Object.entries(archives).map(async ([name, path]) => [name, { path, sha256: digest(await readFile(path)) }])));
    consumer = await realpath(await mkdtemp(join(tmpdir(), 'flashwright-public-artifacts-')));
    registry = await startConsumerRegistry(Object.values(archives));
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'public-artifact-consumer', private: true, dependencies: { '@flashwright/test': '0.0.0', flashwright: '0.0.0' } }));
    const installation = spawn(requireBun(), ['install', '--ignore-scripts', '--omit=optional', '--omit=peer', '--registry', registry.url], { cwd: consumer, env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(consumer, 'cache') } });
    let output = '';
    for (const stream of [installation.stdout, installation.stderr]) stream.on('data', bytes => { output += bytes; });
    const exitCode = await new Promise((complete, reject) => { installation.on('error', reject); installation.on('close', complete); });
    await writeFile(join(destination, 'install.log'), output); assert.equal(exitCode, 0, output);
    report.installedCompiledFiles = {};
    for (const [name, paths] of Object.entries({ core: ['index.js', 'tracing.js', 'runner-integration.js', 'runner-lifecycle.js'], runner: ['index.js', 'runner-artifact-coordinator.js', 'runner-trace-finalizer.js', 'screenshot-recorder.js'] })) {
      const packageDirectory = dirname(createRequire(join(consumer, 'package.json')).resolve(`@flashwright/${name}/package.json`));
      for (const path of paths) {
        const source = `packages/flashwright-${name}/dist/commonjs/${path}`;
        const actual = digest(await readFile(join(packageDirectory, 'dist/commonjs', path)));
        assert.equal(actual, digest(await readFile(source)), `packed consumer has current ${path}`);
        report.installedCompiledFiles[source] = actual;
      }
    }
  }
  const fixtureDirectory = consumer ? join(consumer, 'tests') : destination;
  await mkdir(fixtureDirectory, { recursive: true });
  for (const name of ['api.spec.cjs', 'coordinator.spec.cjs', 'coordinator-fixtures.cjs', 'policies.spec.cjs', 'interruption.spec.cjs', 'interruption-reporter.cjs', 'public-stock.spec.cjs', 'public-options.spec.cjs', 'public-module.spec.mjs', 'public-pending-module.spec.mjs', 'playwright.config.cjs']) await writeFile(join(fixtureDirectory, name), await readFile(`compatibility/m2/runner-artifact-coordinator/${name}`));
  const consumerRequire = consumer ? createRequire(join(consumer, 'package.json')) : undefined;
  const modules = consumerRequire ? join(dirname(consumerRequire.resolve('@flashwright/runner/package.json')), 'dist/commonjs') : resolve('packages/flashwright-runner/dist/commonjs');
  const executable = consumerRequire ? join(dirname(consumerRequire.resolve('@flashwright/test/package.json')), 'cli.cjs') : resolve('packages/flashwright-runner/cli.cjs');
  const child = spawn('python3', [resolve('tools/watchdog.py'), '--timeout', '180', '--report-directory', join(destination, 'watchdog'), '--', process.execPath, executable, 'test', '--config', join(fixtureDirectory, 'playwright.config.cjs')], {
    cwd: consumer ?? process.cwd(), env: { ...process.env, FLASHWRIGHT_COORDINATOR_API: api ? '1' : '0', FLASHWRIGHT_COORDINATOR_PUBLIC: publicRunner ? '1' : '0', FLASHWRIGHT_COORDINATOR_FIXTURES: publicFixtures ? '1' : '0', FLASHWRIGHT_COORDINATOR_POLICIES: policies ? '1' : '0', FLASHWRIGHT_COORDINATOR_INTERRUPTION: interruption ? '1' : '0', FLASHWRIGHT_COORDINATOR_MODULES: modules, FLASHWRIGHT_COORDINATOR_OUTPUT: join(destination, 'output'), FLASHWRIGHT_COORDINATOR_RESULTS: join(destination, 'results.json') }, stdio: ['ignore', 'pipe', 'pipe'],
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
  assert.equal(results.stats.expected, interruption ? 0 : policies ? publicRunner ? 24 : 21 : publicFixtures ? 18 : 6); assert.equal(results.stats.unexpected, interruption ? 0 : policies ? publicRunner ? 8 : 7 : 0); assert.equal(results.errors.length, 0);
  assert.equal(attempts(results.suites).length, interruption ? 1 : policies ? publicRunner ? 72 : 63 : publicFixtures ? 18 : 6);
  for (const attempt of attempts(results.suites)) {
    if (interruption) assert.equal(attempt.status, 'interrupted');
    else if (!policies) assert.equal(attempt.status, 'passed');
    else {
      const status = attempt.expectedStatus === 'skipped' ? 'skipped' : attempt.title.startsWith('original timeout') ? 'timedOut' : attempt.title.startsWith('expected failure') || attempt.title.startsWith('flaky') && attempt.retry < 2 ? 'failed' : 'passed';
      assert.equal(attempt.status, status);
      if (status === 'failed') assert(attempt.errors.some(error => error.message.includes(attempt.title.startsWith('flaky') ? `original flaky failure ${attempt.retry}` : 'original expected failure')));
      if (status === 'timedOut') assert(attempt.errors.some(error => error.message.includes('500ms')));
    }
    const traceErrors = attempt.attachments.filter(item => item.name === 'trace-error');
    const unclaimedCreation = attempt.title.startsWith('pending module publication');
    assert.equal(traceErrors.length, Number(unclaimedCreation), JSON.stringify(attempt.attachments));
    if (unclaimedCreation) {
      assert.equal(attempt.errors.length, 0);
      assert.match(Buffer.from(traceErrors[0].body, 'base64').toString(), /runner.tracing: context creation began before trace ownership/);
    }
    assert.equal(attempt.attachments.filter(item => item.name === 'screenshot-error').length, 0, JSON.stringify(attempt.attachments));
    const screenshots = attempt.attachments.filter(item => item.name === 'screenshot');
    const screenshotCount = api ? Number(attempt.project === 'native-capture' && attempt.title.startsWith('API mixed')) : policies || interruption ? Number(attempt.status !== 'skipped' && attempt.status !== attempt.expectedStatus) : attempt.project === 'native-capture' ? attempt.title.startsWith('manual') ? 3 : attempt.title.startsWith('worker option') ? 2 : 1 : 0;
    assert.equal(screenshots.length, screenshotCount);
    const screenshotHashes = [];
    for (const screenshot of screenshots) {
      const bytes = await readFile(screenshot.path);
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      screenshotHashes.push(digest(bytes));
    }
    const attachments = attempt.attachments.filter(item => item.name === 'trace'); assert.equal(attachments.length, Number(shouldRetain(attempt)), `${attempt.project}: ${attempt.title} retry ${attempt.retry}`);
    if (!attachments.length) {
      report.attempts.push({ title: attempt.title, project: attempt.project, status: attempt.status, expectedStatus: attempt.expectedStatus, retry: attempt.retry, libraries: 0, traceErrors: traceErrors.length, screenshotHashes });
      continue;
    }
    const path = attachments[0].path;
    execFileSync('python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as archive: assert archive.testzip() is None', path]);
    const archive = new utils.ZipFile(path);
    try {
      const names = await archive.entries();
      const contents = new Map(await Promise.all(names.map(async name => [name, await archive.read(name)])));
      const libraries = names.filter(name => /^\d+-trace\.trace$/.test(name));
      assert.equal(libraries.length, api ? attempt.title.startsWith('API mixed') ? 3 : 1 : attempt.status === 'skipped' || attempt.title.startsWith('pending module publication') ? 0 : attempt.title.startsWith('manual') ? 3 : attempt.title.startsWith('worker option') ? 2 : 1);
      const loader = new iso.TraceLoader();
      await loader.load({ entryNames: async () => names, readText: async name => contents.get(name)?.toString(), hasEntry: async name => contents.has(name), isLive: () => false });
      assert.equal(loader.contextEntries.length, libraries.length + 1);
      const runner = contents.get('test.trace').toString().trim().split('\n').map(JSON.parse);
      const steps = new Map(runner.filter(event => event.type === 'before').map(event => [event.stepId, event]));
      if (attempt.title.startsWith('stock page fixture')) {
        const parent = [...steps.values()].find(event => event.title === 'stock fixture parent');
        assert(parent, 'public user step is retained');
        const assertion = [...steps.values()].find(event => event.method === 'expect' && event.title.includes('toHaveTitle'));
        assert.equal(assertion?.parentId, parent.stepId, 'public assertion keeps its user-step parent');
        const attachment = runner.flatMap(event => event.attachments ?? []).find(item => item.name === 'original body');
        assert.equal(attachment?.contentType, 'text/plain');
        assert.equal(contents.get(`resources/${attachment.sha1}`)?.toString(), 'original attachment bytes');
      }
      const records = libraries.flatMap(name => contents.get(name).toString().trim().split('\n').map(JSON.parse));
      const actions = records.filter(event => event.type === 'before');
      if (libraries.length) assert(actions.length > 0);
      for (const action of actions) {
        assert(steps.has(action.stepId), `${attempt.title}: missing original runner step ${action.stepId}`);
        assert.equal(steps.get(action.stepId).title, action.title);
      }
      if (api) {
        const apiContexts = records.filter(event => event.type === 'context-options' && event.browserName === '');
        assert.equal(apiContexts.length, attempt.title.startsWith('API mixed') ? 2 : 1);
        const network = names.filter(name => /-trace\.network$/.test(name)).flatMap(name => contents.get(name).toString().trim().split('\n').filter(Boolean).map(JSON.parse));
        const apiEntries = network.filter(event => event.snapshot?._apiRequest);
        const expectedPaths = attempt.title.startsWith('API first') ? ['/before', '/first'] : attempt.title.startsWith('API successor') ? ['/second'] : ['/manual', '/after'];
        assert.deepEqual(apiEntries.map(event => new URL(event.snapshot.request.url).pathname).sort(), attempt.project === 'native-capture' ? expectedPaths.sort() : []);
        for (const { snapshot } of apiEntries) {
          const path = new URL(snapshot.request.url).pathname;
          assert.equal(contents.get(`resources/${snapshot.response.content._sha1}`)?.toString(), `api:${path}:0`);
          if (path === '/second') assert.equal(contents.get(`resources/${snapshot.request.postData._sha1}`)?.length, 0);
        }
        report.apiCaptureChecks ??= [];
        report.apiCaptureChecks.push({ title: attempt.title, project: attempt.project, apiContexts: apiContexts.length, wireAttempts: apiEntries.length });
      }
      if ((!api || attempt.title.startsWith('API mixed')) && (['native-capture', 'default-capture'].includes(attempt.project) || (policies || interruption) && attempt.project === 'on') && libraries.length) assert(records.some(event => event.type === 'frame-snapshot'));
      assert.equal(names.some(name => name.startsWith('resources/src@')), !policies && !interruption);
      report.attempts.push({ title: attempt.title, project: attempt.project, status: attempt.status, expectedStatus: attempt.expectedStatus, retry: attempt.retry, archiveSha256: digest(await readFile(path)), libraries: libraries.length, actions: actions.length, entries: names.length, screenshotHashes });
    } finally { archive.close(); }
  }
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(digest(await readFile(driver)), report.driverSha256);
  assert.equal(digest(await readFile(browser)), report.browser.sha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  await registry?.close();
  if (consumer) await rm(consumer, { recursive: true, force: true });
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, attempts: report.attempts.length, error: report.error }));
}
