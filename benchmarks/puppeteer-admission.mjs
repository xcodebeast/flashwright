import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { startFixtureServer } from './fixture-server.mjs';
import { preparePuppeteerWorkload } from './puppeteer-workloads.mjs';
import { identifyBrowser } from '../tools/browser-identity.mjs';
import { runtimeMetadata } from '../tools/javascript-runtime.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const reportPath = process.argv[2];
assert.ok(reportPath, 'Pass a new report path to preserve partial admission work');
const phase = name => process.stderr.write(`puppeteer admission: ${name}\n`);
phase('load configuration');
const configuration = JSON.parse(await readFile('benchmarks/configurations/baseline.json', 'utf8'));
const sampling = process.argv[3] === undefined ? undefined : { launchIndex: Number(process.argv[3]), reportPersistence: 'after-completion', isolationProbe: 'separate-admission', protocolLogging: 'off' };
assert.ok(process.argv.length <= 4);
if (sampling) assert.ok(Number.isInteger(sampling.launchIndex) && sampling.launchIndex >= 0 && sampling.launchIndex < configuration.independentLaunches);
const contenderConfiguration = JSON.parse(await readFile('benchmarks/configurations/competitors.json', 'utf8'));
const contender = contenderConfiguration.competitors.find(competitor => competitor.id === 'puppeteer');
const dependencyDirectory = process.env.FLASHWRIGHT_COMPETITOR_DIRECTORY;
assert.ok(dependencyDirectory, 'Set FLASHWRIGHT_COMPETITOR_DIRECTORY to the isolated pinned Puppeteer installation');
for (const name of ['package.json', 'bun.lock']) {
  assert.deepEqual(await readFile(join(dependencyDirectory, name)), await readFile(`benchmarks/competitors/puppeteer/${name}`), `Install the pinned competitor ${name} without changing its dependency graph`);
}
const dependencyRequire = createRequire(join(resolve(dependencyDirectory), 'package.json'));
const packagePath = dependencyRequire.resolve('puppeteer-core/package.json');
const packageManifest = JSON.parse(await readFile(packagePath, 'utf8'));
assert.equal(packageManifest.version, contender.version);
phase('import pinned package');
const { default: puppeteer } = await import(pathToFileURL(dependencyRequire.resolve('puppeteer-core')).href);
phase('identify browser');
assert.ok(process.env.FLASHWRIGHT_BROWSER_PATH, 'Set FLASHWRIGHT_BROWSER_PATH to the pinned Chromium executable');
const browserIdentity = sampling ? JSON.parse(await readFile(join(dirname(reportPath), 'launch-inputs.json'), 'utf8')).browser : await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
assert.equal(browserIdentity.executablePath, resolve(process.env.FLASHWRIGHT_BROWSER_PATH));
assert.equal(browserIdentity.version, contenderConfiguration.browserVersion);
const policy = JSON.parse(await readFile('crates/flashwright-browser/src/chromium-launch-policy.json', 'utf8'));
const profile = await mkdtemp(join(tmpdir(), 'flashwright-puppeteer-profile-'));
const arguments_ = policy.headless.map(argument => argument === '--user-data-dir=__FLASHWRIGHT_PROFILE__' ? `--user-data-dir=${profile}` : argument);
const report = {
  schemaVersion: 1, engine: contender.id, ...runtimeMetadata, package: { name: packageManifest.name, version: packageManifest.version, manifestSha256: hash(await readFile(packagePath)), lockSha256: hash(await readFile(join(dependencyDirectory, 'bun.lock'))) },
  browser: browserIdentity, configuration, launchArguments: null, workloads: [], failures: [], isolation: null,
  ...(sampling ? { sampling } : {}),
  scope: sampling ? 'Library sampling outcomes only. Separate isolation admission and current-source comparative gates remain required.' : 'Functional admission only. Elapsed times are retained observations, excluded from comparative performance acceptance.',
  adaptations: [
    'Pinned reference Chromium flags replace Puppeteer default flags; initial blank-page waiting is disabled because the shared policy uses no-startup-window. CDP pipe and the configured viewport remain explicit.',
    'Native Puppeteer locators retain their default visibility, enabled, viewport and two-frame stability checks. ARIA selectors identify buttons and the labelled input.',
    'Text/title assertions use a small explicit page.waitForFunction helper with mutation polling, unique text targets and a 5-second deadline. This is a workload predicate, not Playwright matcher parity.',
    'The expected missing-element failure uses native waitForSelector visibility and its actual TimeoutError. It is not a Playwright assertion diagnostic comparison.',
    'Native input-event counts are retained. A changed count is a semantic difference, never silently normalized.',
  ],
};
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
if (!sampling) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
const started = performance.now();
let server;
let browser;
try {
  server = await startFixtureServer(configuration.backendDelayMilliseconds);
  phase('launch browser');
  const launchStarted = performance.now();
  browser = await puppeteer.launch({ executablePath: browserIdentity.executablePath, ignoreDefaultArgs: true, args: arguments_, pipe: true, protocol: 'cdp', waitForInitialPage: false, defaultViewport: configuration.viewport, timeout: 30000 });
  report.launchMilliseconds = performance.now() - launchStarted;
  report.launchArguments = browser.process().spawnargs.slice(1).map(argument => argument.startsWith('--user-data-dir=') ? '--user-data-dir=__FLASHWRIGHT_PROFILE__' : argument);
  report.browserVersion = (await browser.version()).replace(/^(?:HeadlessChrome|Chrome)\//, '');
  if (!sampling) await save();
  if (!sampling) {
    phase('context isolation');
    const contexts = [];
    try {
      contexts.push(await browser.createBrowserContext());
      contexts.push(await browser.createBrowserContext());
      const first = await contexts[0].newPage();
      const second = await contexts[1].newPage();
      await first.goto(`${server.origin}/fixture`);
      await first.evaluate(() => { localStorage.setItem('isolation', 'first'); document.cookie = 'isolation=first'; });
      await second.goto(`${server.origin}/fixture`);
      report.isolation = await second.evaluate(() => ({ storage: localStorage.getItem('isolation'), cookies: document.cookie }));
    } finally { await Promise.all(contexts.map(context => context.close())); }
    await save();
  }
  const offset = (sampling?.launchIndex ?? 0) % configuration.workloads.length;
  const order = configuration.workloads.slice(offset).concat(configuration.workloads.slice(0, offset));
  for (const name of order) {
    phase(name);
    const record = { name, samples: [], warmupSamples: [], failures: [] };
    report.workloads.push(record);
    const workloadStarted = performance.now();
    let workload;
    try {
      workload = await preparePuppeteerWorkload(name, browser, server.origin, configuration);
      record.preparationMilliseconds = performance.now() - workloadStarted;
      measurement: for (const [phase, count] of [['warmupSamples', configuration.warmupIterations], ['samples', configuration.measuredIterations]]) {
        for (let iteration = 0; iteration < count; iteration++) {
          const sampleStarted = performance.now();
          try { record[phase].push({ iteration, ...await workload.run(), milliseconds: performance.now() - sampleStarted }); }
          catch (error) {
            record.failures.push({ phase, iteration, milliseconds: performance.now() - sampleStarted, error: error.stack });
            if (!sampling) await save();
            break measurement;
          }
          if (!sampling) await save();
        }
      }
      record.observations = await workload.observe();
    } catch (error) { record.failures.push({ phase: 'preparation', error: error.stack }); }
    finally {
      try { await workload?.close(); } catch (error) { record.failures.push({ phase: 'cleanup', error: error.stack }); }
      record.completeMilliseconds = performance.now() - workloadStarted;
      if (!sampling) await save();
    }
    if (record.failures.length) {
      report.abortedAfterUnexpectedFailure = name;
      break;
    }
  }
} catch (error) { report.failures.push(error.stack); }
finally {
  try { await browser?.close(); } catch (error) { report.failures.push(error.stack); }
  try { await server?.close(); } catch (error) { report.failures.push(error.stack); }
  try { await rm(profile, { recursive: true, force: true }); } catch (error) { report.failures.push(error.stack); }
  report.completeMilliseconds = performance.now() - started;
  report.backend = server?.counts;
  if (!sampling) await save();
  process.stdout.write(JSON.stringify(report) + '\n');
}
