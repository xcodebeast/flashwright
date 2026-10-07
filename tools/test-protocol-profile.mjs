import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeProtocol } from '../benchmarks/protocol-profile.mjs';

function fixture() {
  const clock = phase => ({ kind: 'clock', phase, samples: Array.from({ length: 16 }, () => ({ before: '1000000', node: '101001000', after: '1002000' })) });
  const records = [
    clock('beforeBrowserLaunch'),
    { kind: 'launch', browser: '/chromium', arguments: ['--user-data-dir=owned'] },
    { kind: 'send', id: 1, method: 'Runtime.evaluate', bytes: 50, monotonicNanoseconds: '15000000' },
    { kind: 'send', id: 2, method: 'Page.enable', bytes: 30, monotonicNanoseconds: '20000000' },
    { kind: 'receive', id: 2, error: false, bytes: 20, monotonicNanoseconds: '50000000' },
    { kind: 'receive', id: 1, error: false, bytes: 60, monotonicNanoseconds: '80000000' },
    clock('beforeBrowserClose'),
  ];
  return { records, phases: [{ name: 'work.samples.0', started: '110000000', finished: '210000000' }] };
}
const analyze = ({ records, phases }) => analyzeProtocol(records, phases, '/chromium', ['--user-data-dir=__FLASHWRIGHT_PROFILE__']);

test('independent clock epochs and overlapping commands preserve accounting without double-counting waits', () => {
  const result = analyze(fixture());
  assert.equal(result.commandCount, 2);
  assert.equal(result.replyCount, 2);
  assert.equal(result.sentBytes, 80);
  assert.equal(result.receivedBytes, 80);
  assert.deepEqual(result.ambiguousPhaseCommands, []);
  assert.deepEqual(result.outsidePhaseCommands, []);
  assert.equal(result.phases[0].evaluationCommands, 1);
  assert.equal(result.phases[0].acknowledgementUnionMilliseconds, 65);
  assert.equal(result.phases[0].outsideAcknowledgementsMilliseconds, 35);
});

test('clock discontinuities invalidate attribution', () => {
  const source = fixture();
  source.records.at(-1).samples.forEach(sample => { sample.node = '201001000'; });
  assert.throws(() => analyze(source), /Clock calibrations disagree/);
});

test('commands near a phase boundary remain in global counts without arbitrary phase assignment', () => {
  const source = fixture();
  source.phases[0].started = '115000000';
  const result = analyze(source);
  assert.equal(result.commandCounts['Runtime.evaluate'], 1);
  assert.equal(result.phases[0].commandCount, 1);
  assert.deepEqual(result.ambiguousPhaseCommands, [{ identity: '/1', method: 'Runtime.evaluate' }]);
});

test('lost replies and duplicate command identities invalidate attribution', () => {
  const missing = fixture();
  missing.records = missing.records.filter(record => !(record.kind === 'receive' && record.id === 1));
  assert.throws(() => analyze(missing), /lacks its reply/);
  const duplicate = fixture();
  duplicate.records.splice(3, 0, { ...duplicate.records[2] });
  assert.throws(() => analyze(duplicate), /Duplicate CDP command identity/);
});
