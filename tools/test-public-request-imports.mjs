import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const originalSpawn = childProcess.spawn;
let spawnCalls = 0;
childProcess.spawn = () => {
  spawnCalls++;
  throw new Error('Importing the native public APIs must not start a subprocess');
};
syncBuiltinESMExports();
try {
  const library = await import('flashwright');
  assert.equal(typeof library.request.newContext, 'function');
  const libraryModules = Object.keys(require.cache);
  assert.ok(!libraryModules.some(path => /flashwright-runner[\\/]dist|playwright[\\/]lib[\\/](?:index|worker)/.test(path)), 'Library request import must not load the runner');
  const commonLibrary = require('flashwright');
  assert.equal(typeof library.chromium.launch, 'function');
  assert.equal(commonLibrary.request, library.request);
  assert.equal(commonLibrary.chromium, library.chromium);
  const runner = await import('@flashwright/test');
  const commonRunner = require('@flashwright/test');
  const alias = await import('flashwright/test');
  const commonAlias = require('flashwright/test');
  for (const entryPoint of [runner, commonRunner, alias, commonAlias]) {
    assert.equal(entryPoint.request, library.request);
    assert.equal(entryPoint.chromium, library.chromium);
  }
  assert.equal(spawnCalls, 0);
  console.log(JSON.stringify({ status: 'passed', checks: ['ordinary library import avoids runner loading', 'ESM CommonJS and test facade share native request and chromium identities', 'imports allocate no engine or browser process'] }));
} finally {
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
}
