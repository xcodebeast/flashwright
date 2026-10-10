import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { verifyPuppeteerAdmission } from '../benchmarks/competitor-contract.mjs';

const destinationArgument = process.argv[2];
assert.ok(destinationArgument, 'Usage: run-competitor-admission.mjs NEW_OUTPUT_DIRECTORY');
assert.ok(process.env.FLASHWRIGHT_COMPETITOR_DIRECTORY, 'Set FLASHWRIGHT_COMPETITOR_DIRECTORY to the pinned isolated dependency installation');
assert.ok(process.env.FLASHWRIGHT_BROWSER_PATH, 'Set FLASHWRIGHT_BROWSER_PATH to the pinned browser');
const destination = resolve(destinationArgument);
await mkdir(destination);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputPaths = ['tools/run-competitor-admission.mjs', 'benchmarks/puppeteer-admission.mjs', 'benchmarks/puppeteer-workloads.mjs', 'benchmarks/competitor-contract.mjs', 'benchmarks/fixture-server.mjs', 'tools/http-fixture.mjs', 'tools/browser-identity.mjs', 'tools/javascript-runtime.mjs', 'tools/watchdog.py', 'benchmarks/configurations/baseline.json', 'benchmarks/configurations/competitors.json', 'benchmarks/competitors/puppeteer/package.json', 'benchmarks/competitors/puppeteer/bun.lock', 'crates/flashwright-browser/src/chromium-launch-policy.json'];
const readInputs = async () => Object.fromEntries(await Promise.all(inputPaths.map(async path => [path, hash(await readFile(path))])));

/** Freeze installed executable dependency bytes, following links once without filesystem cycles. */
async function dependencyManifest(directory) {
  const manifest = {};
  const visited = new Set();
  async function visit(path) {
    const absolute = join(directory, path);
    const resolved = await realpath(absolute);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    if ((await stat(absolute)).isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await visit(join(path, name));
    } else manifest[path] = hash(await readFile(absolute));
  }
  for (const path of ['package.json', 'bun.lock', 'node_modules']) await visit(path);
  return manifest;
}

const dependencies = resolve(process.env.FLASHWRIGHT_COMPETITOR_DIRECTORY);
const inputs = await readInputs();
const installedDependencies = await dependencyManifest(dependencies);
const browserSha256 = hash(await readFile(process.env.FLASHWRIGHT_BROWSER_PATH));
const runtime = process.env.FLASHWRIGHT_COMPETITOR_RUNTIME ?? process.execPath;
assert.ok(isAbsolute(runtime), 'FLASHWRIGHT_COMPETITOR_RUNTIME must be an absolute executable path');
const runtimeSha256 = hash(await readFile(runtime));
await writeFile(join(destination, 'inputs.json'), JSON.stringify({ inputs, installedDependencies, browserSha256, runtime: { executable: runtime, sha256: runtimeSha256 } }, null, 2) + '\n', { flag: 'wx' });
const childArguments = ['tools/watchdog.py', '--timeout', '90', '--report', join(destination, 'resources.json'), '--', runtime, 'benchmarks/puppeteer-admission.mjs', join(destination, 'sample.json')];
const child = spawn('python3', childArguments, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
let diagnostics = '';
child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
child.stderr.setEncoding('utf8').on('data', chunk => { diagnostics += chunk; });
const exit = await new Promise(resolve => {
  child.on('error', error => resolve({ code: null, error: error.message }));
  child.on('close', (code, signal) => resolve({ code, signal }));
});
await writeFile(join(destination, 'stdout.txt'), output, { flag: 'wx' });
await writeFile(join(destination, 'stderr.txt'), diagnostics, { flag: 'wx' });
const result = { schemaVersion: 1, status: 'failed', exit, functionalAdmissionPassed: false, performanceAccepted: false };
try {
  assert.deepEqual(await readInputs(), inputs, 'Admission source changed during execution');
  assert.deepEqual(await dependencyManifest(dependencies), installedDependencies, 'Installed competitor dependency bytes changed during execution');
  for (const name of ['package.json', 'bun.lock']) {
    assert.equal(installedDependencies[name], inputs[`benchmarks/competitors/puppeteer/${name}`], `Installed competitor ${name} differs from the checked-in pin`);
  }
  assert.equal(hash(await readFile(process.env.FLASHWRIGHT_BROWSER_PATH)), browserSha256, 'Browser bytes changed during execution');
  assert.equal(hash(await readFile(runtime)), runtimeSha256, 'JavaScript runtime bytes changed during execution');
  result.inputsUnchanged = true;
  assert.equal(exit.code, 0);
  const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
  const sample = await readJson(join(destination, 'sample.json'));
  assert.equal(sample.browser.sha256, browserSha256);
  assert.deepEqual(JSON.parse(output), sample, 'Completed output differs from retained report');
  Object.assign(result, verifyPuppeteerAdmission(sample, await readJson(join(destination, 'resources.json')), await readJson('benchmarks/configurations/baseline.json'), await readJson('benchmarks/configurations/competitors.json'), await readJson('crates/flashwright-browser/src/chromium-launch-policy.json')), { status: 'passed-functional-admission' });
} catch (error) { result.error = error.stack; }
result.files = Object.fromEntries(await Promise.all((await readdir(destination)).sort().map(async name => [name, hash(await readFile(join(destination, name)))])));
await writeFile(join(destination, 'admission.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ destination, status: result.status, differences: result.differences, error: result.error }, null, 2));
process.exitCode = result.functionalAdmissionPassed ? 0 : 1;
