import { dirname, join, sep } from 'node:path';
import { runnerGlobals, upstreamDirectory, upstreamRequire } from './upstream-runtime.js';
import { types } from 'node:util';
import { failure } from '@flashwright/core';
import { runnerIntegration } from '@flashwright/core/runner-integration';
import type { TestInfo } from 'flashwright-upstream-runner/test';
import { discardDisabledRunnerTrace } from './runner-trace-off.js';

type Journal = ReturnType<typeof runnerIntegration.beginTraceJournal>;
interface PinnedTracing {
  _traceEvents: unknown[];
  _contextCreatedEvent: unknown;
  _liveTraceFile?: unknown;
  traceOptions(): { attachments: boolean; sources: boolean; live: boolean } | undefined;
  appendForError(error: unknown): void;
  appendStdioToTrace(type: 'stdout' | 'stderr', chunk: string | Buffer): void;
  appendBeforeActionForStep(options: unknown): void;
  appendAfterActionForStep(callId: unknown, error: unknown, attachments?: readonly unknown[], annotations?: unknown): void;
  _appendTraceEvent(event: unknown): void;
}

export interface RunnerJournalAdmission {
  readonly journal?: Journal;
  readonly failure?: unknown;
}

const coreDirectory = dirname(upstreamRequire.resolve('playwright-core/package.json'));
const { iso } = upstreamRequire('playwright-core/lib/coreBundle') as {
  iso: { monotonicTime(): number; parseStackFrame(line: string, separator: string, showInternals: boolean): { file?: string } | undefined };
};
const admitted = new WeakMap<PinnedTracing, RunnerJournalAdmission>();
const discard = (): void => {};

function field(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object' || types.isProxy(value)) throw failure('ProtocolError', 'runner.tracing', 'unexpected pinned trace admission metadata');
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor && !('value' in descriptor)) throw failure('ProtocolError', 'runner.tracing', 'trace admission metadata contains an accessor');
  return descriptor?.value;
}

/** Only framework records may precede the first zero-dependency worker or all-hooks fixture. */
function initialRecords(tracing: PinnedTracing, fixture: string, skippedCleanup: boolean): unknown[] {
  const events = tracing._traceEvents;
  if (types.isProxy(events) || !Array.isArray(events) || events.length < 3 || events.length > 4 || events[0] !== tracing._contextCreatedEvent) throw failure('ProtocolError', 'runner.tracing', 'unexpected early runner trace prefix');
  const phase = field(events[1], 'title');
  const afterSkippedTest = skippedCleanup && phase === 'After Hooks' && events.length === 4;
  if (field(events[0], 'type') !== 'context-options' || field(events[1], 'type') !== 'before' || field(events[1], 'method') !== 'hook' || phase !== 'Before Hooks' && !afterSkippedTest) throw failure('ProtocolError', 'runner.tracing', 'unexpected early runner trace prefix');
  const hookTitle = events.length === 4 ? field(events[2], 'title') : undefined;
  const expectedHooks = afterSkippedTest ? ['afterAll hook'] : ['beforeAll hook', 'beforeEach hook'];
  if (events.length === 4 && (field(events[2], 'type') !== 'before' || field(events[2], 'method') !== 'hook' || typeof hookTitle !== 'string' || !expectedHooks.includes(hookTitle))) throw failure('ProtocolError', 'runner.tracing', 'user work preceded runner trace admission');
  const last = events[events.length - 1];
  if (field(last, 'type') !== 'before' || field(last, 'method') !== 'fixture' || field(last, 'title') !== `Fixture "${fixture}"`) throw failure('ProtocolError', 'runner.tracing', 'runner trace fixture order changed');
  return events.slice(1);
}

/** Preserve the pinned stack filter after the journal has bounded input text. */
function parseErrorStack(stack: string): unknown[] {
  const frames: unknown[] = [];
  let start = 0;
  let lines = 0;
  while (start < stack.length) {
    if (++lines > 1024) throw failure('ResourceLimitError', 'runner.tracing', 'runner error stack exceeds 1024 lines');
    const newline = stack.indexOf('\n', start);
    const end = newline === -1 ? stack.length : newline;
    const frame = iso.parseStackFrame(stack.slice(start, end), sep, Boolean(process.env.PWDEBUGIMPL));
    if (frame?.file && (process.env.PWDEBUGIMPL || !frame.file.startsWith(join(upstreamDirectory, 'lib')) && !frame.file.startsWith(coreDirectory))) frames.push(frame);
    start = end + 1;
  }
  return frames;
}

/** Replace all allocation-producing callers synchronously; the coordinator owns final stop and disposal. */
export function adoptRunnerTraceJournal(fixture: string, testInfo: TestInfo | undefined = runnerGlobals.currentTestInfo()): RunnerJournalAdmission | undefined {
  return adoptJournal(testInfo, tracing => initialRecords(tracing, fixture, testInfo?.status === 'skipped' && testInfo.expectedStatus === 'skipped'));
}

/** The owned worker calls this after policy normalization and before any fixture or live write. */
export function adoptRunnerTraceAtStart(testInfo: TestInfo): RunnerJournalAdmission | undefined {
  return adoptJournal(testInfo, tracing => {
    const events = tracing._traceEvents;
    if (types.isProxy(events) || !Array.isArray(events) || events.length !== 1 || events[0] !== tracing._contextCreatedEvent || field(events[0], 'type') !== 'context-options')
      throw failure('ProtocolError', 'runner.tracing', 'user work preceded the owned runner trace boundary');
    return [];
  });
}

function adoptJournal(testInfo: TestInfo | undefined, prefixRecords: (tracing: PinnedTracing) => unknown[]): RunnerJournalAdmission | undefined {
  if (!testInfo) throw failure('ProtocolError', 'runner.tracing', 'the pinned fixture boundary has no current test');
  const tracing = (testInfo as TestInfo & { _tracing: PinnedTracing })._tracing;
  const existing = admitted.get(tracing);
  if (existing) return existing;
  const options = tracing.traceOptions();
  if (!options) { discardDisabledRunnerTrace(testInfo); return undefined; }
  let journal: Journal | undefined;
  let admissionFailure: unknown;
  try {
    const prefix = prefixRecords(tracing);
    if (field(options, 'live') || tracing._liveTraceFile) throw failure('UnsupportedFeatureError', 'test.use.trace.live', 'live runner traces are not implemented');
    journal = runnerIntegration.beginTraceJournal(6, tracing._contextCreatedEvent, { sources: Boolean(field(options, 'sources')), attachments: Boolean(field(options, 'attachments')) });
    for (const event of prefix) journal.append(event);
  } catch (error) { admissionFailure = error; }
  tracing.appendForError = journal ? error => journal.appendError(error, parseErrorStack) : discard;
  tracing.appendStdioToTrace = journal ? (type, chunk) => journal.appendStdio(type, chunk, iso.monotonicTime()) : discard;
  tracing.appendBeforeActionForStep = journal ? options => journal.appendBeforeAction(options, iso.monotonicTime()) : discard;
  tracing.appendAfterActionForStep = journal ? (callId, error, attachments, annotations) => journal.appendAfterAction(callId, error, attachments, annotations, iso.monotonicTime()) : discard;
  tracing._appendTraceEvent = journal ? event => journal.append(event) : discard;
  // Clear only an ordinary pinned array; an invalid private replacement cannot retain our records.
  if (Array.isArray(tracing._traceEvents) && !types.isProxy(tracing._traceEvents)) tracing._traceEvents.length = 0;
  const admission = Object.freeze({ ...(journal ? { journal } : {}), ...(admissionFailure === undefined ? {} : { failure: admissionFailure }) });
  admitted.set(tracing, admission);
  return admission;
}
