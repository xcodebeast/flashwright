import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { hash } from './competitor-inputs.mjs';
import { verifyPuppeteerSample, verifyWebdriverSample } from '../benchmarks/competitor-contract.mjs';

const directory = process.argv[2];
assert.ok(directory && process.argv.length === 3, 'Usage: verify-competitor-sampling.mjs RETAINED_DIRECTORY');
const read = async path => JSON.parse(await readFile(join(directory, path), 'utf8'));
const source = async path => JSON.parse(await readFile(path, 'utf8'));
const report = await read('sample.json');
const resources = await read('resources.json');
const receipt = await read('admission.json');
const inputs = await read('inputs.json');
const launchInputs = await read('launch-inputs.json');
assert.ok(['puppeteer', 'webdriverio'].includes(report.engine));
assert.equal(receipt.status, 'passed-sampling-outcomes');
assert.equal(receipt.inputsUnchanged, true);
assert.equal(receipt.exit.code, 0);
assert.equal(receipt.exit.signal, null);
const retained = (await readdir(directory)).filter(name => name !== 'admission.json').sort();
assert.deepEqual(Object.keys(receipt.files).sort(), retained, 'Retained file inventory changed');
for (const [path, expected] of Object.entries(receipt.files)) {
  assert.ok(path && !isAbsolute(path) && normalize(path) === path && !path.includes('/') && !path.includes('\\'));
  assert.ok((await lstat(join(directory, path))).isFile(), 'Expected an original regular file');
  assert.equal(hash(await readFile(join(directory, path))), expected, path);
}
for (const [path, expected] of Object.entries(inputs.inputs)) {
  assert.ok(path && !isAbsolute(path) && normalize(path) === path && !path.split(/[\\/]/).includes('..'));
  assert.equal(hash(await readFile(path)), expected, `Source changed: ${path}`);
}
for (const path of ['package.json', 'bun.lock']) assert.equal(inputs.installedDependencies[path], inputs.inputs[`benchmarks/competitors/${report.engine}/${path}`]);
assert.deepEqual(report.browser, launchInputs.browser);
assert.equal(report.browser.sha256, inputs.browserSha256);
if (report.engine === 'webdriverio') {
  assert.equal(report.driver.sha256, inputs.driverSha256);
  assert.equal(launchInputs.driver.sha256, inputs.driverSha256);
  assert.equal(report.driver.versionOutput, launchInputs.driver.versionOutput);
  assert.ok(resources.processes.some(process => process.process === report.browserProcessId), 'Browser PID must belong to the observed child process tree');
  assert.doesNotMatch(await readFile(join(directory, 'chromedriver.log'), 'utf8'), /^\[[\d.]+\]\[(?:DEBUG|INFO)\]:/m, 'Sampling must not contain verbose driver logging');
}
assert.deepEqual(report, JSON.parse(await readFile(join(directory, 'stdout.txt'), 'utf8')));
assert.equal(resources.command.length, 4);
assert.equal(resources.command[0], inputs.runtime.executable);
assert.equal(resources.command[1], `benchmarks/${report.engine}-admission.mjs`);
assert.ok(resources.command[2].endsWith('/sample.json'));
assert.equal(resources.command[3], String(report.sampling?.launchIndex));
const verify = report.engine === 'puppeteer' ? verifyPuppeteerSample : verifyWebdriverSample;
const decision = verify(report, resources, await source('benchmarks/configurations/baseline.json'), await source('benchmarks/configurations/competitors.json'),
  await source('crates/flashwright-browser/src/chromium-launch-policy.json'), report.engine === 'webdriverio' ? await source('benchmarks/configurations/webdriverio-launch-policy.json') : undefined);
for (const [key, value] of Object.entries(decision)) assert.deepEqual(receipt[key], value, `Changed sampling decision: ${key}`);
console.log(`Verified ${report.engine} sampling outcomes, source/binary identity records, retained hashes and cleanup. Separate admission and comparative performance gates remain required.`);
