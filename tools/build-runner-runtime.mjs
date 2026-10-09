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
    if (flashwrightTraceHooks.onTraceStart?.(this._testInfo))
      return;
    if (!this._options)
      return;
    if (!this._liveTraceFile && this._options.live) {`;

/** Own a pinned runtime tree so worker selection and all private globals resolve normally. */
export async function buildRunnerRuntime(destination) {
  const manifest = JSON.parse(await readFile('compatibility/upstream/runner-runtime-manifest.json', 'utf8'));
  assert.equal(manifest.version, '1.60.0');
  for (const [path, digest] of Object.entries(manifest.files)) {
    let bytes = await readFile(join(sourceDirectory, path));
    assert.equal(hash(bytes), digest, `Pinned runner input changed: ${path}`);
    if (path === 'lib/worker/workerProcessEntry.js') {
      const source = bytes.toString();
      assert.equal(source.split(originalBoundary).length, 2, 'Pinned trace startup boundary must occur exactly once');
      assert.equal(source.split('var TestTracing = class {').length, 2, 'Pinned trace class must occur exactly once');
      bytes = Buffer.from(source.replace(originalBoundary, adaptedBoundary).replace('var TestTracing = class {', 'var flashwrightTraceHooks = require("../../flashwright-hooks.cjs");\nvar TestTracing = class {'));
    }
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await writeFile(join(destination, path), bytes);
  }
  await writeFile(join(destination, 'flashwright-hooks.cjs'), await readFile('packages/flashwright-runner/runner-hooks.cjs'));
  await writeFile(join(destination, 'NOTICE.flashwright'), 'Flashwright modifies lib/worker/workerProcessEntry.js to call its original-attempt trace adapter before fixture setup and live trace writes. The surrounding Playwright 1.60.0 runtime is unchanged.\n');
}
