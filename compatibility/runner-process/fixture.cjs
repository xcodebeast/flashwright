const { SuiteCollector } = require('../../packages/flashwright-runner/dist/commonjs/independent/suite-collector.js');
const { currentFiniteTestInfo } = require('../../packages/flashwright-runner/dist/commonjs/independent/suite-runtime.js');
const { appendFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const record = event => appendFileSync(process.env.FW_PROCESS_EVENTS, JSON.stringify({ ...event, pid: process.pid })+'\n');
if (process.env.FW_PROCESS_CASE === 'fatal-after-done') {
  const original = process.send.bind(process);
  process.send = (message, ...args) => {
    const sent = original(message, ...args);
    if (message.type === 'done') original({ type: 'fatal', error: { message: 'failure after final result sentinel' } });
    return sent;
  };
}
exports.loadSuite = async workerInfo => {
  const collector = new SuiteCollector();
  const test = collector.createTest().extend({
    worker: [async ({}, use) => { record({ event: 'worker-setup', ...workerInfo }); await use(1); record({ event: 'worker-teardown', ...workerInfo }); if (process.env.FW_PROCESS_CASE === 'teardown') throw new Error('worker cleanup sentinel'); }, { scope: 'worker', auto: true }],
  });
  await collector.collect('process.spec.ts', () => {
    const kind = process.env.FW_PROCESS_CASE;
    const body = async () => {
      const info = currentFiniteTestInfo(); record({ event: 'begin', title: info.title, retry: info.retry, ...workerInfo });
      if (kind === 'parallel') await new Promise(resolve => setTimeout(resolve, 80));
      if (kind === 'retry' && info.title === 'B' && info.retry === 0) throw new Error('body sentinel');
      if (kind === 'crash' && info.title === 'B' && info.retry === 0) process.exit(19);
      if (kind === 'hang' && info.title === 'B' && info.retry === 0) { while (true) {} }
      if (kind === 'descendant' && info.title === 'B') {
        const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready');"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        await new Promise(resolve => child.once('message', resolve));
        record({ event: 'descendant', childPid: child.pid });
        while (true) {}
      }
      record({ event: 'end', title: info.title, retry: info.retry, ...workerInfo });
    };
    if (kind === 'parallel' || kind === 'reuse') test.describe.configure({ mode: 'parallel' });
    if (kind === 'setup') {
      test.describe('setup', () => {
        test.beforeAll(() => { if (currentFiniteTestInfo().retry === 0) throw new Error('setup sentinel'); });
        test('A', body); test('B', body);
      });
      test('C', body);
    } else {
      for (const title of kind === 'parallel' ? ['A','B','C','D','E','F','G','H'] : ['A','B','C']) test(title, body);
    }
  });
  return collector.seal();
};
