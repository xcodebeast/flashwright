import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { startFixtureServer } from './fixture-server.mjs';
import { identifyBrowser } from '../tools/browser-identity.mjs';
import { runtimeMetadata } from '../tools/javascript-runtime.mjs';
import { hash } from '../tools/competitor-inputs.mjs';

assert.ok(['darwin', 'linux'].includes(process.platform), 'Cypress admission supports macOS and Linux');
const linux = process.platform === 'linux';
const reportPath = resolve(process.argv[2]);
const output = dirname(reportPath);
const dependencies = resolve(process.env.FLASHWRIGHT_COMPETITOR_DIRECTORY);
const bundle = resolve(process.env.FLASHWRIGHT_CYPRESS_BUNDLE);
const configuration = JSON.parse(await readFile('benchmarks/configurations/baseline.json', 'utf8'));
const contenders = JSON.parse(await readFile('benchmarks/configurations/competitors.json', 'utf8'));
const version = contenders.competitors.find(contender => contender.id === 'cypress').version;
for (const name of ['package.json', 'bun.lock']) assert.deepEqual(await readFile(join(dependencies, name)), await readFile(`benchmarks/competitors/cypress/${name}`));
const dependencyRequire = createRequire(join(dependencies, 'package.json'));
const packagePath = dependencyRequire.resolve('cypress/package.json');
const packageManifest = JSON.parse(await readFile(packagePath, 'utf8'));
const bundleManifest = JSON.parse(await readFile(join(bundle, linux ? 'resources/app/package.json' : 'Contents/Resources/app/package.json'), 'utf8'));
assert.equal(packageManifest.version, version);
assert.equal(bundleManifest.version, version);
if (linux) process.env.FLASHWRIGHT_BROWSER_PATH = await realpath(process.env.FLASHWRIGHT_BROWSER_PATH);
const browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
assert.equal(browser.version, configuration.browserVersion);
const project = join(output, 'project');
await mkdir(project);
const projectFiles = ['cypress.config.cjs', 'workloads.cy.js', ...(linux ? ['linux-processes.cjs', 'linux-title-policy.cjs', 'linux-environment-policy.cjs'] : [])];
for (const name of projectFiles) await copyFile(`benchmarks/cypress/${name}`, join(project, name));
await writeFile(join(project, 'admission-configuration.json'), JSON.stringify(configuration, null, 2) + '\n', { flag: 'wx' });
Object.assign(process.env, {
  CYPRESS_RUN_BINARY: join(bundle, linux ? 'Cypress' : 'Contents/MacOS/Cypress'),
  FLASHWRIGHT_CYPRESS_OWNER: String(process.pid),
  FLASHWRIGHT_CYPRESS_LAUNCH_REPORT: join(output, 'launch.json'),
  FLASHWRIGHT_CYPRESS_OBSERVATIONS: join(output, 'observations.jsonl'),
  FLASHWRIGHT_CYPRESS_PROCESSES: join(output, 'browser-processes.json'),
});
const report = {
  schemaVersion: 1, platform: process.platform, architecture: process.arch, engine: 'cypress', comparisonClass: 'runner-outcome', ...runtimeMetadata,
  package: { name: packageManifest.name, version, manifestSha256: hash(await readFile(packagePath)), lockSha256: hash(await readFile(join(dependencies, 'bun.lock'))) },
  bundle: { version: bundleManifest.version, electronVersion: bundleManifest.electronVersion, electronNodeVersion: bundleManifest.electronNodeVersion, executableSha256: hash(await readFile(process.env.CYPRESS_RUN_BINARY)) },
  browser, configuration, failures: [], result: null,
  scope: 'Ordinary Cypress runner outcomes only. Default synthetic inputs, per-test storage reset and proxy/runner launch policy differ from native-input/fresh-context library flows. No performance acceptance.',
};
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
const started = performance.now();
let server;
try {
  server = await startFixtureServer(configuration.backendDelayMilliseconds);
  const cypress = dependencyRequire('cypress');
  const result = await cypress.run({ project, browser: browser.executablePath, headless: true, record: false, config: { baseUrl: server.origin, video: false, screenshotOnRunFailure: false } });
  await writeFile(join(output, 'runner-result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  report.result = {
    browserName: result.browserName, browserPath: result.browserPath, browserVersion: result.browserVersion, cypressVersion: result.cypressVersion,
    totalDuration: result.totalDuration, totalTests: result.totalTests, totalPassed: result.totalPassed, totalFailed: result.totalFailed, totalPending: result.totalPending, totalSkipped: result.totalSkipped,
    failures: result.failures, message: result.message,
    configuration: result.config ? { video: result.config.video, screenshotOnRunFailure: result.config.screenshotOnRunFailure, retries: result.config.retries, testIsolation: result.config.testIsolation, viewportWidth: result.config.viewportWidth, viewportHeight: result.config.viewportHeight } : null,
    runs: result.runs?.map(run => ({ error: run.error, stats: run.stats, tests: run.tests, screenshots: run.screenshots, video: run.video })),
  };
  report.launch = JSON.parse(await readFile(join(output, 'launch.json'), 'utf8'));
  report.observations = (await readFile(join(output, 'observations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  report.browserProcesses = JSON.parse(await readFile(join(output, 'browser-processes.json'), 'utf8'));
} catch (error) { report.failures.push(error?.stack ?? String(error)); }
finally {
  try { await server?.close(); } catch (error) { report.failures.push(error?.stack ?? String(error)); }
  report.backend = server?.counts;
  report.completeMilliseconds = performance.now() - started;
  await save();
  console.log(`flashwright-cypress-report ${hash(await readFile(reportPath))}`);
}
