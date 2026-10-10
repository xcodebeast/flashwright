import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applicationCorpusDirectory, loadApplicationCorpus, materializeApplicationTests, startApplicationServer } from '../benchmarks/application-corpus.mjs';
import { identifyBrowser } from './browser-identity.mjs';
import { dependencyManifest, hash } from './competitor-inputs.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { applicationConfiguration, applicationResults, verifyApplicationRun } from '../benchmarks/application-suite-contract.mjs';

assert.ok([3, 4].includes(process.argv.length), 'Usage: run-application-suite.mjs NEW_OUTPUT_DIRECTORY [todomvc|svgomg]');
const applicationName = process.argv[3] ?? 'todomvc';
const corpusDirectory = applicationCorpusDirectory(applicationName);
const directory = resolve(process.argv[2]);
const runtime = process.env.FLASHWRIGHT_APPLICATION_RUNTIME ?? process.execPath;
assert.ok(isAbsolute(runtime));
for (const name of ['FLASHWRIGHT_BROWSER_PATH', 'FLASHWRIGHT_DRIVER_PATH']) assert.ok(process.env[name], `Set ${name}`);
const browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
const driverPath = resolve(process.env.FLASHWRIGHT_DRIVER_PATH);
const corpus = await loadApplicationCorpus(corpusDirectory);
assert.equal(corpus.manifest.applicationName, applicationName);
const sources = await sourceManifest();
const dependencies = await dependencyManifest('.');
const identities = async () => ({ runtime: hash(await readFile(runtime)), browser: hash(await readFile(browser.executablePath)), driver: hash(await readFile(driverPath)) });
const binaries = await identities();
await mkdir(directory);
await writeFile(join(directory, 'inputs.json'), JSON.stringify({ applicationName, workspaceDirectory: resolve('.'), outputDirectory: directory, sources, dependencies, binaries, runtime, browser, driverPath, corpusManifestSha256: corpus.manifestSha256 }, null, 2) + '\n');
const server = await startApplicationServer(corpus);
const require = createRequire(import.meta.url);
const receipt = { schemaVersion: 2, applicationName, status: 'failed', applicationAdmissionPassed: false, performanceAccepted: false,
  scope: `Offline upstream ${applicationName} functional suite through installed development packages. Setup URL and package imports adapted; all ${corpus.manifest.expectedTests} callback bodies unchanged. ${corpus.manifest.assertionTests} assertion cases. No comparative timing or packed-package claim.`,
  expectedTests: corpus.manifest.expectedTests, assertionTests: corpus.manifest.assertionTests, runs: {}, files: {} };
try {
  for (const engine of ['playwright', 'flashwright']) {
    const project = join(directory, engine);
    await mkdir(project);
    const adapter = join(project, 'adapter.mjs');
    const packageName = engine === 'playwright' ? '@playwright/test' : '@flashwright/test';
    const guard = engine === 'flashwright' ? `import { forbidUpstreamBrowserBackend } from ${JSON.stringify(pathToFileURL(resolve('benchmarks/native-backend-guard.mjs')).href)}; forbidUpstreamBrowserBackend();\n` : '';
    await writeFile(adapter, `${guard}export { test, expect, defineConfig } from ${JSON.stringify(import.meta.resolve(packageName))};\n`);
    const generatedSources = await materializeApplicationTests(corpus, project, adapter);
    const configuration = applicationConfiguration(project, browser);
    const configurationPath = join(project, 'runner.config.mjs');
    await writeFile(configurationPath, `import { defineConfig } from './adapter.mjs'; export default defineConfig(${JSON.stringify(configuration)});\n`);
    const generatedHashes = { 'adapter.mjs': hash(await readFile(adapter)), 'runner.config.mjs': hash(await readFile(configurationPath)), ...Object.fromEntries(generatedSources.map(source => [source.path, source.generatedSha256])) };
    const executable = engine === 'playwright' ? join(dirname(require.resolve('playwright/package.json')), 'cli.js') : resolve('packages/flashwright-test/cli.cjs');
    const requestOffset = server.requests.length;
    const command = [runtime, executable, 'test', '--config', configurationPath];
    const child = spawn('python3', ['tools/watchdog.py', '--timeout', '240', '--report', join(project, 'resources.json'), '--', ...command], {
      env: { ...process.env, FLASHWRIGHT_APPLICATION_URL: server.url, FLASHWRIGHT_BROWSER_PATH: browser.executablePath, FLASHWRIGHT_DRIVER_PATH: driverPath,
        FORCE_COLOR: '0', PLAYWRIGHT_FORCE_TTY: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const exit = await new Promise(resolve => { child.on('error', error => resolve({ code: null, error: error.message })); child.on('close', (code, signal) => resolve({ code, signal })); });
    await writeFile(join(project, 'stdout.txt'), stdout);
    await writeFile(join(project, 'stderr.txt'), stderr);
    const run = receipt.runs[engine] = { exit, command, configuration, generatedSources, generatedHashes, requests: server.requests.slice(requestOffset), tests: [], errors: [] };
    await writeFile(join(project, 'requests.json'), JSON.stringify(run.requests, null, 2) + '\n');
    try {
      const report = JSON.parse(await readFile(join(project, 'report.json'), 'utf8'));
      run.stats = report.stats;
      run.errors = report.errors;
      run.tests = applicationResults(report);
      const resources = JSON.parse(await readFile(join(project, 'resources.json'), 'utf8'));
      for (const [path, expected] of Object.entries(generatedHashes)) assert.equal(hash(await readFile(join(project, path))), expected, path);
      Object.assign(run, verifyApplicationRun({ run, report, resources, corpus, project, browser, command }));
    } catch (error) { run.validationError = error.stack ?? String(error); run.passed = false; }
    console.log(JSON.stringify({ engine, exit, stats: run.stats, validationError: run.validationError }));
  }
  assert.deepEqual(await sourceManifest(), sources, 'Source changed during verification');
  assert.deepEqual(await dependencyManifest('.'), dependencies, 'Installed packages changed during verification');
  assert.deepEqual(await identities(), binaries, 'Executable bytes changed during verification');
  assert.equal((await loadApplicationCorpus(corpusDirectory)).manifestSha256, corpus.manifestSha256);
  receipt.inputsUnchanged = true;
  assert.deepEqual(receipt.runs.playwright.tests.map(({ file, title }) => ({ file, title })), receipt.runs.flashwright.tests.map(({ file, title }) => ({ file, title })));
  receipt.applicationAdmissionPassed = Object.values(receipt.runs).every(run => run.passed);
  receipt.status = receipt.applicationAdmissionPassed ? 'passed-application-outcomes' : 'application-gaps';
} catch (error) { receipt.error = error.stack ?? String(error); }
finally {
  try { await server.close(); }
  catch (error) {
    receipt.status = 'failed';
    receipt.applicationAdmissionPassed = false;
    receipt.error = error.stack ?? String(error);
  }
  async function record(path = '') {
    for (const name of (await readdir(join(directory, path))).sort()) {
      const relative = join(path, name);
      if ((await stat(join(directory, relative))).isDirectory()) await record(relative);
      else receipt.files[relative] = hash(await readFile(join(directory, relative)));
    }
  }
  await record();
  await writeFile(join(directory, 'admission.json'), JSON.stringify(receipt, null, 2) + '\n');
}
console.log(JSON.stringify({ directory, status: receipt.status, applicationAdmissionPassed: receipt.applicationAdmissionPassed, error: receipt.error }));
process.exitCode = receipt.applicationAdmissionPassed ? 0 : 1;
