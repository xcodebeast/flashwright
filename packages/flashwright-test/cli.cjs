#!/usr/bin/env node
const { dirname, join } = require('node:path');
const arguments_ = process.argv.slice(2);
if (arguments_[0] === '--version') console.log('Flashwright 0.0.0 (Playwright Test 1.60.0)');
else if (!arguments_.length || arguments_[0] === '--help') console.log('Usage: flashwright test [Playwright Test selection/config/reporting options]\nInstall the matching Flashwright platform runtime and provide the pinned Chromium. FLASHWRIGHT_DRIVER_PATH remains available for development.');
else if (arguments_[0] !== 'test' || arguments_.some(argument => ['--ui', '--ui-host', '--ui-port', '--debug'].some(flag => argument === flag || argument.startsWith(flag + '=')))) {
  console.error('UnsupportedFeatureError: only noninteractive flashwright test execution is implemented.'); process.exitCode = 1;
} else require(join(dirname(require.resolve('flashwright-upstream-runner/package.json')), 'cli.js'));
