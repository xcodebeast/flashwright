#!/usr/bin/env node
const { dirname, join } = require('node:path');
if (!process.argv.includes('--runner=independent')) require(join(dirname(require.resolve('@flashwright/runner/package.json')), 'dist/upstream/flashwright-source-transform.cjs')).registerOwnedBootstrap(__filename);
require('@flashwright/runner/cli');
