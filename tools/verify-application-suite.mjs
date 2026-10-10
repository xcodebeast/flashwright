import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applicationCorpusDirectory, applicationGeneratedSources, loadApplicationCorpus } from '../benchmarks/application-corpus.mjs';
import { applicationConfiguration, verifyApplicationRun } from '../benchmarks/application-suite-contract.mjs';
import { dependencyManifest, hash } from './competitor-inputs.mjs';
import { sourceManifest } from './source-manifest.mjs';

export async function verifyApplicationSuite(retainedDirectory, { portable = false } = {}) {
  const directory = resolve(retainedDirectory);
  const read = async path => JSON.parse(await readFile(join(directory, path), 'utf8'));
  const inputs = await read('inputs.json');
  const receipt = await read('admission.json');
  assert.equal(receipt.schemaVersion, 2, 'Older diagnostic receipts need a fresh source-bound run');
  assert.equal(receipt.inputsUnchanged, true);
  assert.equal(receipt.performanceAccepted, false);
  assert.equal(receipt.error, undefined);
  assert.equal(inputs.workspaceDirectory, portable ? '/workspace' : resolve('.'), 'Verify from the recorded workspace');
  const workspacePath = path => {
    if (!portable) return path;
    const prefix = resolve('.') + '/';
    assert.ok(path.startsWith(prefix), 'Package entry must belong to this workspace');
    return '/workspace/' + path.slice(prefix.length);
  };
  const workspaceUrl = url => portable ? pathToFileURL(workspacePath(fileURLToPath(url))).href : url;
  assert.ok(isAbsolute(inputs.outputDirectory));
  assert.deepEqual(await sourceManifest(), inputs.sources, 'Verify from the recorded source checkout');
  if (!portable) assert.deepEqual(await dependencyManifest('.'), inputs.dependencies, 'Installed packages changed');
  else {
    assert.equal(inputs.outputDirectory, '/retained/application');
    assert.equal(inputs.runtime, '/runtime/executable');
    assert.equal(inputs.browser.executablePath, '/browser/executable');
    assert.equal(inputs.driverPath, '/driver/executable');
    assert.ok(Object.keys(inputs.dependencies).length > 0);
    for (const [path, digest] of Object.entries(inputs.dependencies)) {
      assert.ok(!isAbsolute(path) && normalize(path) === path && !path.split(/[\\/]/).includes('..'));
      assert.match(digest, /^[a-f0-9]{64}$/);
    }
  }
  for (const [name, path] of Object.entries({ runtime: inputs.runtime, browser: inputs.browser.executablePath, driver: inputs.driverPath })) {
    assert.ok(isAbsolute(path));
    assert.match(inputs.binaries[name], /^[a-f0-9]{64}$/);
    if (!portable) assert.equal(hash(await readFile(path)), inputs.binaries[name], name);
  }
  assert.equal(inputs.browser.sha256, inputs.binaries.browser);
  const files = {};
  async function inventory(path = '') {
    for (const name of (await readdir(join(directory, path))).sort()) {
      const relative = join(path, name);
      const information = await lstat(join(directory, relative));
      assert.equal(information.isSymbolicLink(), false);
      if (information.isDirectory()) await inventory(relative);
      else {
        assert.ok(information.isFile());
        if (relative !== 'admission.json' && !(portable && relative === 'snapshot.json')) files[relative] = hash(await readFile(join(directory, relative)));
      }
    }
  }
  await inventory();
  assert.deepEqual(receipt.files, files, 'Retained bytes or inventory changed');
  assert.equal(receipt.applicationName, inputs.applicationName);
  const corpus = await loadApplicationCorpus(applicationCorpusDirectory(inputs.applicationName));
  assert.equal(corpus.manifest.applicationName, inputs.applicationName);
  assert.equal(inputs.corpusManifestSha256, corpus.manifestSha256);
  assert.equal(receipt.expectedTests, corpus.manifest.expectedTests);
  assert.equal(receipt.assertionTests, corpus.manifest.assertionTests);
  assert.deepEqual(Object.keys(receipt.runs).sort(), ['flashwright', 'playwright']);
  const require = createRequire(import.meta.url);
  const decisions = {};
  for (const engine of ['playwright', 'flashwright']) {
    const run = receipt.runs[engine];
    assert.equal(run.validationError, undefined);
    const project = join(inputs.outputDirectory, engine);
    const packageName = engine === 'playwright' ? '@playwright/test' : '@flashwright/test';
    const guard = engine === 'flashwright' ? `import { forbidUpstreamBrowserBackend } from ${JSON.stringify(pathToFileURL(workspacePath(resolve('benchmarks/native-backend-guard.mjs'))).href)}; forbidUpstreamBrowserBackend();\n` : '';
    const adapter = `${guard}export { test, expect, defineConfig } from ${JSON.stringify(workspaceUrl(import.meta.resolve(packageName)))};\n`;
    const configuration = applicationConfiguration(project, inputs.browser);
    const expectedFiles = {
      'adapter.mjs': adapter,
      'runner.config.mjs': `import { defineConfig } from './adapter.mjs'; export default defineConfig(${JSON.stringify(configuration)});\n`,
    };
    const generatedSources = [];
    for (const { contents, record } of applicationGeneratedSources(corpus, join(project, 'adapter.mjs'))) {
      expectedFiles[record.path] = contents;
      generatedSources.push(record);
    }
    assert.deepEqual(run.generatedSources, generatedSources, 'Changed migration source record');
    assert.deepEqual(run.generatedHashes, Object.fromEntries(Object.entries(expectedFiles).map(([path, contents]) => [path, hash(contents)])));
    for (const [path, contents] of Object.entries(expectedFiles)) assert.equal(await readFile(join(directory, engine, path), 'utf8'), contents, `Changed generated source: ${engine}/${path}`);
    assert.deepEqual(await read(`${engine}/requests.json`), run.requests, 'Changed HTTP request record');
    const executable = workspacePath(engine === 'playwright' ? join(dirname(require.resolve('playwright/package.json')), 'cli.js') : resolve('packages/flashwright-test/cli.cjs'));
    const command = [inputs.runtime, executable, 'test', '--config', join(project, 'runner.config.mjs')];
    const report = await read(`${engine}/report.json`);
    const resources = await read(`${engine}/resources.json`);
    const decision = verifyApplicationRun({ run, report, resources, corpus, project, browser: inputs.browser, command });
    for (const [key, value] of Object.entries(decision)) assert.deepEqual(run[key], value, `Changed ${engine} decision: ${key}`);
    decisions[engine] = decision;
    function checkAttachments(suite) {
      for (const specification of suite.specs ?? []) for (const test of specification.tests) for (const result of test.results) for (const attachment of result.attachments ?? []) {
        if (!attachment.path) continue;
        const prefix = project + '/';
        assert.ok(attachment.path.startsWith(prefix), 'Artifact outside original runner project');
        const relative = attachment.path.slice(prefix.length);
        assert.ok(normalize(relative) === relative && !relative.split(/[\\/]/).includes('..') && !isAbsolute(relative));
        assert.ok(files[join(engine, relative)], 'Missing runner attachment');
      }
      for (const child of suite.suites ?? []) checkAttachments(child);
    }
    for (const suite of report.suites) checkAttachments(suite);
  }
  assert.deepEqual(decisions.playwright.tests.map(({ file, title }) => ({ file, title })), decisions.flashwright.tests.map(({ file, title }) => ({ file, title })));
  const admitted = Object.values(decisions).every(decision => decision.passed);
  assert.equal(receipt.applicationAdmissionPassed, admitted);
  assert.equal(receipt.status, admitted ? 'passed-application-outcomes' : 'application-gaps');
  return { status: portable ? 'verified-portable-application-evidence' : 'verified-current-application-evidence',
    applicationName: inputs.applicationName, applicationAdmissionPassed: admitted, performanceAccepted: false,
    liveExecutableBytesVerified: !portable, installedDependencyBytesVerified: !portable,
    expectedTests: receipt.expectedTests, decisions };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'Usage: verify-application-suite.mjs RETAINED_DIRECTORY');
  const result = await verifyApplicationSuite(process.argv[2]);
  console.log(JSON.stringify(result, null, 2));
}
