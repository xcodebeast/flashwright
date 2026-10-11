import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ownedRuntime = resolve('packages/flashwright-runner/dist/upstream');
require(join(ownedRuntime, 'flashwright-source-transform.cjs')).registerOwnedBootstrap(fileURLToPath(import.meta.url));
const { transform } = require(join(ownedRuntime, 'lib/common/index.js'));
const { sourceMapSupport } = require('playwright-core/lib/utilsBundle');
const core = await transform.requireOrImport(resolve('packages/flashwright-core/dist/commonjs/index.js'));
const { callerLocations, callerStack } = await transform.requireOrImport(resolve('packages/flashwright-core/dist/commonjs/call-sites.js'));
const { runnerIntegration } = require('../packages/flashwright-core/dist/commonjs/runner-integration.js');
await mkdir('.cache', { recursive: true });
const directory = await mkdtemp(resolve('.cache/caller-locations-'));
const fixture = join(directory, 'caller.cts');
const source = `type Context = { newPage(): Promise<unknown> };
const values: Record<string, string> = {
  first: 'first',
  second: 'second',
};
void values;
module.exports = async function userCallSite(context: Context) {
  return await context.newPage();
};
`;
const expectedLine = source.split('\n').findIndex(line => line.includes('return await context.newPage')) + 1;
const removeMapper = runnerIntegration.installSourcePositionMapper(1, position => sourceMapSupport.mapSourcePosition(position));
const originalFormatter = Error.prepareStackTrace;
try {
  await writeFile(fixture, source);
  const caller = await transform.requireOrImport(fixture);
  assert.throws(() => runnerIntegration.installSourcePositionMapper(1, position => position), /already installed/);
  assert.throws(() => runnerIntegration.installSourcePositionMapper(2, position => position), /unsupported runner integration/);
  const originalFailure = Symbol('original operation failure');
  let locations;
  let stack;
  const client = {
    subscribeObject: () => () => {},
    async request() { locations = callerLocations(); stack = callerStack(); throw originalFailure; },
  };
  const context = new core.BrowserContext(client, 'caller-context', {}, null, undefined);
  // An application hook must not participate in browser-command or trace capture.
  Error.prepareStackTrace = () => { throw Error('application stack formatter must not run'); };
  await assert.rejects(caller(context), error => error === originalFailure);
  Error.prepareStackTrace = originalFormatter;
  const location = locations.find(location => location.file === fixture);
  assert.ok(location, 'retain the user caller through transformed framework frames');
  assert.equal(location.line, expectedLine, 'apply the pinned TypeScript transform map exactly once');
  const callLine = source.split('\n')[expectedLine - 1];
  assert.ok(location.column >= callLine.indexOf('newPage') + 1 && location.column <= callLine.indexOf('newPage(') + 'newPage'.length + 1);
  assert.equal(location.function, 'userCallSite');
  assert.ok(stack.includes(`${fixture}:${expectedLine}:`));
  console.log(JSON.stringify({ status: 'passed', runtime: process.versions.bun ? `bun ${process.versions.bun}` : process.version, originalFailurePreserved: true, globalFormatterUntouchedByCapture: true, caller: { line: location.line, column: location.column, function: location.function } }, null, 2));
} finally {
  Error.prepareStackTrace = originalFormatter;
  removeMapper();
  await rm(directory, { recursive: true, force: true });
}
