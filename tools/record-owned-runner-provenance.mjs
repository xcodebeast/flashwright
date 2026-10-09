import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const hash = value => createHash('sha256').update(value).digest('hex');
const implementation = {};
for (const path of ['tools/build-runner-runtime.mjs', 'tools/build-packages.mjs', 'packages/flashwright-runner/runner-hooks.cjs', 'packages/flashwright-runner/src/upstream-runtime.ts', 'packages/flashwright-runner/src/index.ts', 'packages/flashwright-runner/src/runner-trace-off.ts', 'packages/flashwright-runner/src/runner-trace-journal.ts', 'packages/flashwright-runner/src/trace-steps.ts', 'packages/flashwright-runner/cli.cjs', 'packages/flashwright-runner/package.json', 'tools/test-owned-runner-runtime.mjs', 'tools/run-runner-trace-start-tests.mjs', 'compatibility/m2/runner-trace-start/start.spec.cjs', 'compatibility/m2/runner-trace-start/playwright.config.cjs']) implementation[path] = hash(await readFile(path));
const manifestPath = 'compatibility/upstream/runner-runtime-manifest.json';
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const workerPath = 'packages/flashwright-runner/dist/upstream/lib/worker/workerProcessEntry.js';
const output = JSON.stringify({
  referenceVersion: '1.60.0', manifestPath, manifestSha256: hash(await readFile(manifestPath)), sourceFileCount: Object.keys(manifest.files).length,
  sourceWorkerSha256: manifest.files['lib/worker/workerProcessEntry.js'], adaptedWorkerSha256: hash(await readFile(workerPath)), implementation,
  relationship: 'The canonical runner ships its own checksum-pinned Playwright runtime tree. All files except the worker bundle are byte-identical; the bundle imports one local hook module and calls it after capture-policy normalization, before live writes or fixtures. Package name, exports, version, relative worker/loader paths and upstream notices stay intact. CLI, test exports and private globals use only this owned runtime; no prototype, module-resolution or require-cache mutation.',
  contract: 'A single synchronous boolean callback sees the exact original TestInfo, including off attempts and skipped attempts that reach final trace stop without fixtures. True takes ownership and suppresses original live allocation; false or no callback preserves it. Promise results reject synchronously and their rejections are observed. Adapter capture failures belong in bounded admission diagnostics, not thrown callback errors. Final attempt export retains the existing original-instance finalizer.',
  currentScope: 'Public trace-off collection is disabled at this earlier boundary. Enabled automatic traces remain unsupported by public fixture validation. Private capture tests adopt the journal at the one-context-record prefix, preserve policies/retries/expected outcomes/modifiers/skipped final stop, and reject live before filesystem work.',
  dependencyNote: 'The isolated original dependency continues supplying public declaration types and build input. playwright-core is also a direct exact runtime dependency so the owned copy resolves it under nested package-manager layouts. The plain library does not load this runtime.',
  source: 'https://github.com/microsoft/playwright/blob/v1.60.0/packages/playwright/src/worker/testTracing.ts',
  license: 'Apache-2.0', licensePath: 'compatibility/upstream/LICENSE.playwright', modificationNotice: 'packages/flashwright-runner/dist/upstream/NOTICE.flashwright',
}, null, 2) + '\n';
const destination = 'compatibility/upstream/owned-runner-provenance.json';
if (process.argv.includes('--check')) assert.equal(await readFile(destination, 'utf8'), output, 'Owned runner provenance differs');
else await writeFile(destination, output);
console.log('Verified owned pinned runner provenance.');
