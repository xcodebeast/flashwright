import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const runnerDirectory = dirname(require.resolve('flashwright-upstream-runner/package.json'));
const child = spawn(process.execPath, [join(runnerDirectory, 'cli.js'), 'test', '--config', 'compatibility/runner-boundary/playwright.config.ts'], { stdio: 'inherit' });
const exitCode = await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('close', resolve);
});
assert.equal(exitCode, 1, 'The deliberate timeout must make the nested runner exit with failure.');
await import('./verify-runner-boundary.mjs');
