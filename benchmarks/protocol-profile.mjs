import assert from 'node:assert/strict';

const milliseconds = nanoseconds => Number(nanoseconds) / 1e6;
const identity = record => `${record.sessionId ?? ''}/${record.id}`;

/** Correlate byte-level CDP observations with Node phases using measured clock bounds. */
export function analyzeProtocol(records, phases, browserPath, expectedArguments) {
  const launches = records.filter(record => record.kind === 'launch');
  assert.equal(launches.length, 1);
  assert.equal(launches[0].browser, browserPath);
  assert.deepEqual(launches[0].arguments.map(argument => argument.startsWith('--user-data-dir=') ? '--user-data-dir=__FLASHWRIGHT_PROFILE__' : argument), expectedArguments);
  const calibrations = records.filter(record => record.kind === 'clock');
  assert.deepEqual(calibrations.map(record => record.phase), ['beforeBrowserLaunch', 'beforeBrowserClose']);
  let lower;
  let upper;
  for (const calibration of calibrations) {
    assert.equal(calibration.samples.length, 16);
    for (const sample of calibration.samples) {
      const before = BigInt(sample.before);
      const after = BigInt(sample.after);
      const node = BigInt(sample.node);
      assert.ok(after >= before);
      const sampleLower = node - after;
      const sampleUpper = node - before;
      lower = lower === undefined || sampleLower > lower ? sampleLower : lower;
      upper = upper === undefined || sampleUpper < upper ? sampleUpper : upper;
    }
  }
  assert.ok(lower <= upper, 'Clock calibrations disagree; do not correlate phases across a clock discontinuity');
  assert.ok(upper - lower < 2_000_000n, 'Clock uncertainty exceeds the declared two millisecond ceiling');
  const offset = (lower + upper) / 2n;
  const commands = new Map();
  const events = {};
  let sentBytes = 0;
  let receivedBytes = 0;
  let replyCount = 0;
  let exitRecorded = false;
  for (const record of records) {
    assert.ok(['send', 'receive', 'launch', 'clock', 'exit'].includes(record.kind));
    if (record.kind === 'exit') {
      assert.equal(exitRecorded, false);
      assert.equal(record.exitCode, 0);
      assert.deepEqual(record.failures, []);
      exitRecorded = true;
    }
    if (!['send', 'receive'].includes(record.kind)) continue;
    assert.ok(Number.isSafeInteger(record.bytes) && record.bytes > 0);
    if (record.kind === 'send') {
      assert.ok(Number.isSafeInteger(record.id));
      assert.equal(typeof record.method, 'string');
      assert.equal(commands.has(identity(record)), false, 'Duplicate CDP command identity');
      commands.set(identity(record), { ...record, sent: BigInt(record.monotonicNanoseconds) });
      sentBytes += record.bytes;
    } else {
      receivedBytes += record.bytes;
      if (record.id !== undefined) {
        const command = commands.get(identity(record));
        assert.ok(command, 'Reply lacks a retained command');
        assert.equal(command.received, undefined, 'Duplicate reply');
        command.received = BigInt(record.monotonicNanoseconds);
        assert.ok(command.received >= command.sent);
        command.error = record.error;
        replyCount++;
      } else {
        assert.equal(typeof record.method, 'string');
        events[record.method] = (events[record.method] ?? 0) + 1;
      }
    }
  }
  const missingReplies = [...commands.values()].filter(command => command.received === undefined);
  assert.ok(missingReplies.every(command => command.method === 'Browser.close'), 'A non-shutdown command lacks its reply');
  const intervals = phases.map(phase => ({ ...phase, start: BigInt(phase.started), end: BigInt(phase.finished), commands: [] }));
  assert.equal(new Set(phases.map(phase => phase.name)).size, phases.length);
  for (let index = 0; index < intervals.length; index++) {
    assert.ok(intervals[index].end > intervals[index].start);
    if (index) assert.ok(intervals[index].start >= intervals[index - 1].end, 'Overlapping phases');
  }
  const ambiguousPhaseCommands = [];
  const outsidePhaseCommands = [];
  const commandCounts = new Map();
  for (const command of commands.values()) {
    commandCounts.set(command.method, (commandCounts.get(command.method) ?? 0) + 1);
    const candidates = intervals.filter(phase => command.sent + upper >= phase.start && command.sent + lower < phase.end);
    if (candidates.length !== 1 || command.sent + lower < candidates[0].start || command.sent + upper >= candidates[0].end) {
      (candidates.length ? ambiguousPhaseCommands : outsidePhaseCommands).push({ identity: identity(command), method: command.method });
      continue;
    }
    candidates[0].commands.push(command);
  }
  return {
    sentBytes, receivedBytes, commandCount: commands.size, replyCount, events, exitRecorded,
    commandCounts: Object.fromEntries(commandCounts),
    missingShutdownReplies: missingReplies.length,
    clock: { offsetNanoseconds: offset.toString(), lowerOffsetNanoseconds: lower.toString(), upperOffsetNanoseconds: upper.toString(), uncertaintyMilliseconds: milliseconds(upper - lower) },
    ambiguousPhaseCommands, outsidePhaseCommands,
    phases: intervals.map(phase => {
      const methods = {};
      const waiting = [];
      for (const command of phase.commands) {
        const method = methods[command.method] ??= { commands: 0, sentBytes: 0, replies: 0, errors: 0, summedAcknowledgementMilliseconds: 0, maximumAcknowledgementMilliseconds: 0 };
        method.commands++;
        method.sentBytes += command.bytes;
        if (command.received !== undefined) {
          const elapsed = milliseconds(command.received - command.sent);
          method.replies++;
          method.errors += command.error ? 1 : 0;
          method.summedAcknowledgementMilliseconds += elapsed;
          method.maximumAcknowledgementMilliseconds = Math.max(method.maximumAcknowledgementMilliseconds, elapsed);
          const start = command.sent + offset > phase.start ? command.sent + offset : phase.start;
          const end = command.received + offset < phase.end ? command.received + offset : phase.end;
          if (end > start) waiting.push([start, end]);
        }
      }
      waiting.sort((first, second) => first[0] < second[0] ? -1 : first[0] > second[0] ? 1 : 0);
      let union = 0n;
      let lastEnd = phase.start;
      for (const [start, end] of waiting) {
        if (end > lastEnd) {
          union += end - (start > lastEnd ? start : lastEnd);
          lastEnd = end;
        }
      }
      const durationMilliseconds = milliseconds(phase.end - phase.start);
      return {
        name: phase.name, durationMilliseconds, commandCount: phase.commands.length,
        evaluationCommands: phase.commands.filter(command => ['Runtime.evaluate', 'Runtime.callFunctionOn'].includes(command.method)).length,
        acknowledgementUnionMilliseconds: milliseconds(union),
        outsideAcknowledgementsMilliseconds: durationMilliseconds - milliseconds(union),
        methods,
      };
    }),
  };
}
