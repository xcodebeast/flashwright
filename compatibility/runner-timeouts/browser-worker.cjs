const { SuiteCollector } = require('../../packages/flashwright-runner/dist/commonjs/independent/suite-collector.js');
const { chromium } = require('../../packages/flashwright-core/dist/commonjs/index.js');
const { declare } = require('./browser-case.cjs');
exports.loadSuite = async () => {
  const collector = new SuiteCollector();
  await collector.collect('browser-timeout.spec.cjs', () => declare(collector.createTest(), chromium));
  return collector.seal();
};
