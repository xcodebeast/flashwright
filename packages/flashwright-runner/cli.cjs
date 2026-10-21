#!/usr/bin/env node
const { join } = require('node:path');
const arguments_ = process.argv.slice(2);
if (arguments_[0] === '--version') console.log('Flashwright 0.0.0 (Playwright Test 1.60.0)');
else if (!arguments_.length || arguments_[0] === '--help') console.log('Usage: flashwright test [Playwright Test selection/config/reporting options]\nExperimental independent runner: flashwright test --runner=independent --config <file>\nUse @flashwright/test/independent imports for that runner.\nInstall the matching Flashwright platform runtime and provide the pinned Chromium. FLASHWRIGHT_DRIVER_PATH remains available for development.');
else if (arguments_[0] !== 'test' || arguments_.some(argument => ['--ui', '--ui-host', '--ui-port', '--debug'].some(flag => argument === flag || argument.startsWith(flag + '=')))) {
  console.error('UnsupportedFeatureError: only noninteractive flashwright test execution is implemented.'); process.exitCode = 1;
} else if (process.versions.pnp) {
  const { UnsupportedFeatureError } = require('@flashwright/core');
  const error = new UnsupportedFeatureError({ code: 'UnsupportedFeatureError', method: 'flashwright test',
    message: 'Yarn Plug\'n\'Play runner execution is not supported by the pinned runner loader. Set nodeLinker: node-modules in .yarnrc.yml and reinstall. Plain Flashwright library use remains available with PnP.',
    referenceVersion: '1.60.0', browser: 'chromium' });
  console.error(error.toString()); process.exitCode = 1;
} else if (arguments_.includes('--runner=independent')) {
  require('./dist/commonjs/independent/cli.js').runIndependentCLI(arguments_.slice(1).filter(argument => argument !== '--runner=independent')).then(code => { process.exitCode = code; }, error => { console.error(error.stack || String(error)); process.exitCode = 1; });
} else {
  require(join(__dirname, 'dist/upstream/flashwright-source-transform.cjs')).registerOwnedBootstrap(__filename);
  require(join(__dirname, 'dist/upstream/cli.js'));
}
