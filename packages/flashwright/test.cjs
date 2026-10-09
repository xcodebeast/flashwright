const { failure } = require('@flashwright/core');

// The optional peer also serves playwright/test when the public library is aliased.
let runnerPath;
try { runnerPath = require.resolve('@flashwright/test'); }
catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  throw failure('UnsupportedFeatureError', 'flashwright/test', 'install @flashwright/test@0.0.0 alongside flashwright; alias installations using playwright/test also require this canonical optional peer');
}
module.exports = require(runnerPath);
