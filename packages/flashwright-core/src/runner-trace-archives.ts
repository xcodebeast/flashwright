import { failure } from './errors.js';
import type { SealedTraceArchive } from './trace-archive.js';
import type { TracingChunkOptions, TracingStartOptions } from './tracing.js';
import type { RunnerActionObserver } from './runner-actions.js';

export interface RunnerTraceChunk {
  /** Seal this exact chunk and transfer its immutable files to the caller. */
  takeArchive(signal?: AbortSignal): Promise<SealedTraceArchive>;
  /** Discard this exact chunk without reading its source files or replacing another chunk. */
  discard(): Promise<void>;
}

export interface RunnerTraceRecording {
  /** Open another chunk only after the previous owner has retired it. */
  startChunk(options?: TracingChunkOptions): Promise<RunnerTraceChunk>;
  /** Retire this idle recording, preserving a manually opened chunk or replacement recording. */
  stop(): Promise<void>;
}

export interface RunnerTraceRecordingWithActions {
  /** Exact v7 identity, preserved across this recording's explicitly owned chunks. */
  readonly recording: RunnerTraceRecording;
  /** Each attempt supplies its own observer before the new chunk can accept actions. */
  startChunk(observer: RunnerActionObserver, options?: TracingChunkOptions): Promise<RunnerTraceChunk>;
  stop(): Promise<void>;
}

export interface RunnerTraceStartedRecording extends RunnerTraceRecordingWithActions {
  readonly chunk: RunnerTraceChunk;
}

export interface RunnerTraceOperation<Value> {
  readonly ready: Promise<Value>;
  /** Successful cleanup of this operation; live recordings retain their later obligations. */
  readonly cleanup: Promise<void>;
}
export type RunnerTraceStartup = RunnerTraceOperation<RunnerTraceStartedRecording>;

interface RunnerTraceOwner {
  currentChunk(): RunnerTraceChunk | undefined;
  currentRecording(): RunnerTraceRecording | undefined;
  startRecording(options: TracingStartOptions): Promise<RunnerTraceRecording>;
  startRecordingWithActions(options: TracingStartOptions, observer: RunnerActionObserver): Promise<RunnerTraceRecordingWithActions>;
  beginRecordingWithActions(options: TracingStartOptions, observer: RunnerActionObserver): RunnerTraceStartup;
  discardChunk(chunk: RunnerTraceChunk): Promise<void>;
  beginRecordingChunk(recording: RunnerTraceRecording, observer: RunnerActionObserver, options: TracingChunkOptions): RunnerTraceOperation<RunnerTraceChunk>;
  settleClosedCleanup(): Promise<void>;
}

const traceOwners = new WeakMap<object, RunnerTraceOwner>();

/** Keep runner access outside the public Tracing surface and its declarations. */
export function registerRunnerTraceOwner(owner: object, controls: RunnerTraceOwner): void {
  traceOwners.set(owner, controls);
}

function traceOwner(owner: object): RunnerTraceOwner {
  const controls = traceOwners.get(owner);
  if (!controls) throw failure('ProtocolError', 'runner.tracing', 'unknown tracing owner');
  return controls;
}

export function currentRunnerTraceChunk(owner: object): RunnerTraceChunk | undefined { return traceOwner(owner).currentChunk(); }
export function currentRunnerTraceRecording(owner: object): RunnerTraceRecording | undefined { return traceOwner(owner).currentRecording(); }
export function startRunnerTraceRecording(owner: object, options: TracingStartOptions): Promise<RunnerTraceRecording> { return traceOwner(owner).startRecording(options); }
export function startRunnerTraceRecordingWithActions(owner: object, options: TracingStartOptions, observer: RunnerActionObserver): Promise<RunnerTraceRecordingWithActions> { return traceOwner(owner).startRecordingWithActions(options, observer); }
export function beginRunnerTraceRecordingWithActions(owner: object, options: TracingStartOptions, observer: RunnerActionObserver): RunnerTraceStartup { return traceOwner(owner).beginRecordingWithActions(options, observer); }
export function discardRunnerTraceChunk(owner: object, chunk: RunnerTraceChunk): Promise<void> { return traceOwner(owner).discardChunk(chunk); }
export function settleClosedRunnerTraceCleanup(owner: object): Promise<void> { return traceOwner(owner).settleClosedCleanup(); }
export function beginRunnerTraceRecordingChunk(owner: object, recording: RunnerTraceRecording, observer: RunnerActionObserver, options: TracingChunkOptions): RunnerTraceOperation<RunnerTraceChunk> { return traceOwner(owner).beginRecordingChunk(recording, observer, options); }
