import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { bunWebViewSamplingSources } from '../benchmarks/bun-webview-sampling.mjs';
import { verifyBunWebViewSample } from '../benchmarks/bun-webview-sampling-contract.mjs';

assert.equal(process.argv.length, 3, 'Usage: bun tools/verify-bun-webview-sampling.mjs RETAINED_SAMPLE_JSON');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
const configuration = JSON.parse(await readFile('benchmarks/configurations/baseline.json', 'utf8'));
const decision = verifyBunWebViewSample(report, configuration);
assert.deepEqual(Object.keys(report.inputs).sort(), [...bunWebViewSamplingSources].sort());
for (const path of bunWebViewSamplingSources) assert.equal(hash(await readFile(path)), report.inputs[path], `Changed selected source: ${path}`);
assert.equal(hash(await readFile(report.runtime.executable)), report.runtime.sha256, 'Changed runtime');
assert.equal(hash(await readFile(report.browser.executablePath)), report.browser.sha256, 'Changed browser');
console.log(JSON.stringify({ ...decision, selectedInputsVerified: true, externalCollectorVerified: false }));
