import { runnerGlobals } from './upstream-runtime.js';
import { failure } from '@flashwright/core';
import type { TestInfo } from 'flashwright-upstream-runner/test';

interface PinnedTestTracing {
  _traceEvents: unknown[];
  traceOptions(): unknown;
  appendForError(...parameters: unknown[]): void;
  appendStdioToTrace(...parameters: unknown[]): void;
  appendBeforeActionForStep(...parameters: unknown[]): void;
  appendAfterActionForStep(...parameters: unknown[]): void;
  _appendTraceEvent(...parameters: unknown[]): void;
}

const disabled = new WeakSet<PinnedTestTracing>();
const discardTraceEvent = (): void => {};

/** Disable only the current attempt's unused trace journal before user fixtures can append to it. */
export function discardDisabledRunnerTrace(testInfo: TestInfo | undefined = runnerGlobals.currentTestInfo()): void {
  if (!testInfo) throw failure('ProtocolError', 'runner.tracing', 'the pinned fixture boundary has no current test');
  const tracing = (testInfo as TestInfo & { _tracing: PinnedTestTracing })._tracing;
  if (tracing.traceOptions() !== undefined || disabled.has(tracing)) return;
  // Replacing the callers also avoids parameter previews and attachment/base64 conversion.
  tracing.appendForError = discardTraceEvent;
  tracing.appendStdioToTrace = discardTraceEvent;
  tracing.appendBeforeActionForStep = discardTraceEvent;
  tracing.appendAfterActionForStep = discardTraceEvent;
  tracing._appendTraceEvent = discardTraceEvent;
  tracing._traceEvents.length = 0;
  disabled.add(tracing);
}
