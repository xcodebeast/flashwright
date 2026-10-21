const { appendFileSync } = require('node:fs');
const { SuiteCollector } = require('../../packages/flashwright-runner/dist/commonjs/independent/suite-collector.js');
const { timeoutScenarios } = require('./scenarios.mjs');
exports.loadSuite = async () => {
  const collector = new SuiteCollector();
  const scenario = timeoutScenarios((name, event) => appendFileSync(process.env.FW_TIMEOUT_EVENTS, JSON.stringify({ name, event })+'\n')).find(s => s.name === process.env.FW_TIMEOUT_CASE);
  if (!scenario) throw Error('Unknown timeout scenario');
  await collector.collect(scenario.name+'.spec.cjs', () => scenario.declare(collector.createTest()));
  return collector.seal();
};
