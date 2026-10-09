import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

const require = createRequire(resolve('packages/flashwright-runner/package.json'));
const packageRoot = dirname(require.resolve('@flashwright/core/package.json'));
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const common = require('@flashwright/core/runner-integration').runnerIntegration;
const esm = (await import(pathToFileURL(join(packageRoot, manifest.exports['./runner-integration'].import.default)).href)).runnerIntegration;
const { currentRunnerContextDefaults } = require(join(packageRoot, 'dist/commonjs/runner-context-defaults.js'));
assert.equal(common, esm, 'Mixed ESM/CommonJS consumers must share the exact runner boundary');
assert.equal(currentRunnerContextDefaults(), undefined);
const defaults = { contextOptions: { baseURL: 'http://scope.invalid', viewport: { width: 320, height: 240 } }, actionTimeout: 20, navigationTimeout: 30 };
assert.throws(() => common.installContextDefaults(2, defaults), error => error.name === 'ProtocolError');
assert.equal(currentRunnerContextDefaults(), undefined);
assert.throws(() => common.installContextDefaults(1, { ...defaults, actionTimeout: -1 }), error => error.name === 'InvalidArgumentError');
assert.equal(currentRunnerContextDefaults(), undefined);
const restore = common.installContextDefaults(1, defaults);
assert.equal(currentRunnerContextDefaults().contextOptions.baseURL, defaults.contextOptions.baseURL);
assert.throws(() => common.installContextDefaults(1, defaults), error => error.name === 'ProtocolError');
restore(); restore();
assert.equal(currentRunnerContextDefaults(), undefined);
assert.throws(() => {
  const release = common.installContextDefaults(1, defaults);
  try { throw new Error('fixture setup failed'); } finally { release(); }
}, /fixture setup failed/);
assert.equal(currentRunnerContextDefaults(), undefined);
assert.equal(Object.hasOwn(require('@flashwright/core'), 'runnerIntegration'), false, 'The private boundary must not leak through the public facade');
console.log('Runner integration version, canonical identity, overlap rejection and exception-safe restoration passed.');
