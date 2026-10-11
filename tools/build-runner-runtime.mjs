import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const sourceDirectory = dirname(require.resolve('flashwright-upstream-runner/package.json'));
const hash = value => createHash('sha256').update(value).digest('hex');
const originalBoundary = `    if (!this._shouldCaptureTrace()) {
      this._options = void 0;
      return;
    }
    if (!this._liveTraceFile && this._options.live) {`;
const adaptedBoundary = `    if (!this._shouldCaptureTrace())
      this._options = void 0;
    // Flashwright adaptation: the original attempt is owned before live writes and fixtures.
    if (flashwrightTraceHooks.onTraceStart?.(this._testInfo, value))
      return;
    if (!this._options)
      return;
    if (!this._liveTraceFile && this._options.live) {`;

const sourceTransformPreparationBoundary = `  transformInstalled = true;
  installSourceMapSupport();`;
const sourceTransformPreparation = `  const installOriginalSourceLoader = process.versions.bun
    ? require("../../flashwright-source-transform.cjs").prepareOriginalSourceLoader(transformHook, shouldTransform, [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts"])
    : undefined;
`;
const sourceTransformBoundary = `  addHook((code, filename) => {
    return transformHook(code, filename).code;
  }, shouldTransform, [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts"]);`;
const adaptedSourceTransformBoundary = `  if (installOriginalSourceLoader) {
    installOriginalSourceLoader();
  } else {
${sourceTransformBoundary}
  }`;

/** Own a pinned runtime tree so worker selection and all private globals resolve normally. */
export async function buildRunnerRuntime(destination) {
  const manifest = JSON.parse(await readFile('compatibility/upstream/runner-runtime-manifest.json', 'utf8'));
  assert.equal(manifest.version, '1.60.0');
  for (const [path, digest] of Object.entries(manifest.files)) {
    let bytes = await readFile(join(sourceDirectory, path));
    assert.equal(hash(bytes), digest, `Pinned runner input changed: ${path}`);
    if (['lib/worker/workerProcessEntry.js', 'lib/loader/loaderProcessEntry.js'].includes(path)) {
      const source = bytes.toString();
      const directive = '"use strict";';
      assert.ok(source.startsWith(directive), 'Pinned process entry must retain its strict directive');
      bytes = Buffer.from(directive + '\nrequire("../../flashwright-source-transform.cjs").registerOwnedBootstrap(__filename);' + source.slice(directive.length));
    }
    if (path === 'lib/worker/workerProcessEntry.js') {
      const source = bytes.toString();
      assert.equal(source.split(originalBoundary).length, 2, 'Pinned trace startup boundary must occur exactly once');
      assert.equal(source.split('var TestTracing = class {').length, 2, 'Pinned trace class must occur exactly once');
      bytes = Buffer.from(source.replace(originalBoundary, adaptedBoundary).replace('var TestTracing = class {', 'var flashwrightTraceHooks = require("../../flashwright-hooks.cjs");\nvar TestTracing = class {'));
    }
    if (path === 'lib/common/index.js') {
      const source = bytes.toString();
      assert.equal(source.split(sourceTransformPreparationBoundary).length, 2, 'Pinned source transform preparation boundary must occur exactly once');
      assert.equal(source.split(sourceTransformBoundary).length, 2, 'Pinned source transform hook boundary must occur exactly once');
      bytes = Buffer.from(source
        .replace(sourceTransformPreparationBoundary, sourceTransformPreparation + sourceTransformPreparationBoundary)
        .replace(sourceTransformBoundary, adaptedSourceTransformBoundary));
    }
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await writeFile(join(destination, path), bytes);
  }
  await writeFile(join(destination, 'flashwright-source-transform.cjs'), await readFile('packages/flashwright-runner/runner-source-transform.cjs'));
  await writeFile(join(destination, 'flashwright-hooks.cjs'), await readFile('packages/flashwright-runner/runner-hooks.cjs'));
  await writeFile(join(destination, 'NOTICE.flashwright'), 'Flashwright modifies lib/worker/workerProcessEntry.js for original-attempt trace ownership and process-entry source-transform registration, lib/loader/loaderProcessEntry.js for process-entry source-transform registration, and lib/common/index.js for the Bun original-source CommonJS transform. Other pinned Playwright 1.60.0 runtime files are unchanged.\n');
}
