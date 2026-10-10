import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { startFixtureServer } from './fixture-server.mjs';
import { closeWebdriverContexts, createWebdriverPage, prepareWebdriverWorkload } from './webdriverio-workloads.mjs';
import { identifyBrowser } from '../tools/browser-identity.mjs';
import { runtimeMetadata } from '../tools/javascript-runtime.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const reportPath = process.argv[2];
assert.ok(reportPath, 'Pass a new report path to preserve partial admission work');
const phase = name => process.stderr.write(`webdriverio admission: ${name}\n`);
const configuration = JSON.parse(await readFile('benchmarks/configurations/baseline.json', 'utf8'));
const sampling = process.argv[3] === undefined ? undefined : { launchIndex: Number(process.argv[3]), reportPersistence: 'after-completion', isolationProbe: 'separate-admission', protocolLogging: 'warning' };
assert.ok(process.argv.length <= 4);
if (sampling) assert.ok(Number.isInteger(sampling.launchIndex) && sampling.launchIndex >= 0 && sampling.launchIndex < configuration.independentLaunches);
const contenders = JSON.parse(await readFile('benchmarks/configurations/competitors.json', 'utf8'));
const contender = contenders.competitors.find(competitor => competitor.id === 'webdriverio');
const policy = JSON.parse(await readFile('crates/flashwright-browser/src/chromium-launch-policy.json', 'utf8'));
const driverPolicy = JSON.parse(await readFile('benchmarks/configurations/webdriverio-launch-policy.json', 'utf8'));
const dependencyDirectory = process.env.FLASHWRIGHT_COMPETITOR_DIRECTORY;
assert.ok(dependencyDirectory, 'Set FLASHWRIGHT_COMPETITOR_DIRECTORY to the pinned WebdriverIO installation');
for (const name of ['package.json', 'bun.lock']) assert.deepEqual(await readFile(join(dependencyDirectory, name)), await readFile(`benchmarks/competitors/webdriverio/${name}`));
const dependencyRequire = createRequire(join(resolve(dependencyDirectory), 'package.json'));
const packageEntry = dependencyRequire.resolve('webdriverio');
// The pinned package exports its entry point but not its metadata subpath.
const packagePath = join(dirname(packageEntry), '..', 'package.json');
const packageManifest = JSON.parse(await readFile(packagePath, 'utf8'));
assert.equal(packageManifest.name, 'webdriverio');
assert.equal(packageManifest.version, contender.version);
const { remote } = await import(pathToFileURL(packageEntry).href);
assert.ok(process.env.FLASHWRIGHT_BROWSER_PATH);
assert.ok(process.env.FLASHWRIGHT_CHROMEDRIVER_PATH, 'Set FLASHWRIGHT_CHROMEDRIVER_PATH to the pinned ChromeDriver');
const launchInputs = sampling ? JSON.parse(await readFile(join(dirname(reportPath), 'launch-inputs.json'), 'utf8')) : undefined;
const browserIdentity = launchInputs?.browser ?? await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
assert.equal(browserIdentity.executablePath, resolve(process.env.FLASHWRIGHT_BROWSER_PATH));
assert.equal(browserIdentity.version, configuration.browserVersion);
const driverPath = resolve(process.env.FLASHWRIGHT_CHROMEDRIVER_PATH);
const driverVersionOutput = sampling ? launchInputs.driver.versionOutput : execFileSync(driverPath, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
assert.equal(driverVersionOutput.match(/\b\d+\.\d+\.\d+\.\d+\b/)?.[0], driverPolicy.driverVersion);
const profile = await mkdtemp(join(tmpdir(), 'flashwright-webdriverio-profile-'));
const driverLog = join(dirname(resolve(reportPath)), 'chromedriver.log');
const launchArguments = policy.headless.filter(argument => !driverPolicy.removedReferenceSwitches.includes(argument)).map(argument => argument.startsWith('--user-data-dir=') ? `--user-data-dir=${profile}` : argument);
const report = {
  schemaVersion: 1, engine: contender.id, ...runtimeMetadata,
  package: { name: packageManifest.name, version: packageManifest.version, manifestSha256: hash(await readFile(packagePath)), lockSha256: hash(await readFile(join(dependencyDirectory, 'bun.lock'))) },
  browser: browserIdentity, driver: { version: driverPolicy.driverVersion, versionOutput: driverVersionOutput, sha256: sampling ? launchInputs.driver.sha256 : hash(await readFile(driverPath)) },
  configuration, driverPolicy, launchArguments: null, workloads: [], failures: [], isolation: null,
  ...(sampling ? { sampling } : {}),
  scope: sampling ? 'Library sampling outcomes only. Separate isolation admission and current-source comparative gates remain required.' : 'Functional admission only. Timing and resources are excluded from comparative performance acceptance.',
  adaptations: [
    'Native WebdriverIO BiDi operations, ARIA selectors and default action readiness; user-context isolation uses browser.createUserContext and browser.removeUserContext.',
    'Fixture-specific text/title assertions use native waitUntil with the ordinary 500ms polling interval and a 5-second deadline.',
    'Missing-element failure uses native waitForDisplayed with the reference 25ms timeout, not equivalent Playwright assertion diagnostics.',
    'ChromeDriver retains its native added switches and bootstrap page. Reference no-startup-window is removed; actual arguments and every launch-policy difference remain explicit.',
    'Native typing input events remain observable and are never normalized to the reference fill event count.',
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
  browser = await remote({
    logLevel: 'error', connectionRetryCount: 0, connectionRetryTimeout: 20000, waitforTimeout: 5000, waitforInterval: 500,
    capabilities: { browserName: 'chrome', webSocketUrl: true,
      'goog:chromeOptions': { binary: browserIdentity.executablePath, args: launchArguments },
      'wdio:chromedriverOptions': { binary: driverPath, allowedIps: ['127.0.0.1'], allowedOrigins: ['http://localhost'], ...(sampling ? { logLevel: 'WARNING' } : { verbose: true }), logPath: driverLog },
    },
  });
  report.launchMilliseconds = performance.now() - launchStarted;
  report.protocol = browser.isBidi ? 'webdriver-bidi' : 'webdriver-classic';
  report.browserVersion = browser.capabilities.browserVersion;
  report.negotiatedDriverVersion = browser.capabilities.chrome.chromedriverVersion;
  if (sampling) {
    // Chromium's CDP command line includes switches added after process startup.
    // Read the owned PID's launch command to compare the same flags as admission logs.
    const browserProcessId = browser.capabilities['goog:processID'];
    assert.ok(Number.isSafeInteger(browserProcessId) && browserProcessId > 0);
    const command = execFileSync('ps', ['-ww', '-p', String(browserProcessId), '-o', 'command='], { encoding: 'utf8', timeout: 5000 }).trim();
    const prefix = `${browserIdentity.executablePath} `;
    assert.ok(command.startsWith(prefix));
    report.launchArguments = command.slice(prefix.length).replace(`--user-data-dir=${profile}`, '--user-data-dir=__FLASHWRIGHT_PROFILE__').split(' ');
    report.browserProcessId = browserProcessId;
  } else {
    const launchLine = (await readFile(driverLog, 'utf8')).split('\n').find(line => line.includes('Launching chrome: '));
    const prefix = `Launching chrome: ${browserIdentity.executablePath} `;
    assert.ok(launchLine?.includes(prefix));
    report.launchArguments = launchLine.slice(launchLine.indexOf(prefix) + prefix.length).replace(`--user-data-dir=${profile}`, '--user-data-dir=__FLASHWRIGHT_PROFILE__').trim().split(' ');
  }
  if (!sampling) await save();
  if (!sampling) {
    phase('context isolation');
    const contexts = [];
    let isolationError;
    try {
      contexts.push(await createWebdriverPage(browser, configuration.viewport));
      contexts.push(await createWebdriverPage(browser, configuration.viewport));
      await contexts[0].page.navigate(`${server.origin}/fixture`);
      await contexts[0].page.execute(() => { localStorage.setItem('isolation', 'first'); document.cookie = 'isolation=first'; });
      await contexts[1].page.navigate(`${server.origin}/fixture`);
      report.isolation = await contexts[1].page.execute(() => ({ storage: localStorage.getItem('isolation'), cookies: document.cookie }));
    } catch (error) { isolationError = error; }
    await closeWebdriverContexts(contexts, isolationError);
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
      workload = await prepareWebdriverWorkload(name, browser, server.origin, configuration);
      record.preparationMilliseconds = performance.now() - workloadStarted;
      measurement: for (const [phase, count] of [['warmupSamples', configuration.warmupIterations], ['samples', configuration.measuredIterations]]) {
        for (let iteration = 0; iteration < count; iteration++) {
          const sampleStarted = performance.now();
          try { record[phase].push({ iteration, ...await workload.run(), milliseconds: performance.now() - sampleStarted }); }
          catch (error) { record.failures.push({ phase, iteration, milliseconds: performance.now() - sampleStarted, error: error.stack }); if (!sampling) await save(); break measurement; }
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
    if (record.failures.length) { report.abortedAfterUnexpectedFailure = name; break; }
  }
} catch (error) { report.failures.push(error.stack); }
finally {
  try { await browser?.deleteSession(); } catch (error) { report.failures.push(error.stack); }
  try { await server?.close(); } catch (error) { report.failures.push(error.stack); }
  try { await rm(profile, { recursive: true, force: true }); } catch (error) { report.failures.push(error.stack); }
  report.completeMilliseconds = performance.now() - started;
  report.backend = server?.counts;
  if (!sampling) await save();
  process.stdout.write(JSON.stringify(report) + '\n');
}
