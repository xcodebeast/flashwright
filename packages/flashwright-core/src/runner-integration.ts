import { captureFailureContextSnapshot } from './failure-context-snapshot.js';
import { runTraceInternal } from './trace-hooks.js';
import { installSourcePositionMapper, type SourcePositionMapper } from './call-sites.js';
import { failure } from './errors.js';
import { installRunnerContextLifecycle, installAsyncRunnerContextLifecycle, installOwnedRunnerContextLifecycle, installArtifactContextLifecycle, type RunnerContextLifecycle, type AsyncRunnerContextLifecycle, type OwnedRunnerContextLifecycle, type ArtifactContextLifecycle, type RunnerContextLifecycleRegistration } from './runner-lifecycle.js';
import { installRunnerContextDefaults, type RunnerContextDefaults } from './runner-context-defaults.js';
import { installRunnerActionObserver, type RunnerActionObserver } from './runner-actions.js';
import { currentRunnerTraceChunk, currentRunnerTraceRecording, startRunnerTraceRecording, startRunnerTraceRecordingWithActions, beginRunnerTraceRecordingWithActions, discardRunnerTraceChunk, settleClosedRunnerTraceCleanup, type RunnerTraceChunk, type RunnerTraceRecording, type RunnerTraceRecordingWithActions, type RunnerTraceStartup } from './runner-trace-archives.js';
import { beginRunnerTraceRecordingChunk } from './runner-trace-archives.js';
import type { TracingStartOptions, TracingChunkOptions } from './tracing.js';
import { TraceArchiveAssembly } from './trace-archive-assembly.js';
import { RunnerTraceJournal, type RunnerTraceJournalOptions } from './runner-trace-journal.js';
import { installArtifactRequestLifecycle, type ArtifactRequestLifecycle, type RunnerRequestLifecycleRegistration } from './runner-request-lifecycle.js';
import { runnerRequestTraceOwner, type APIRequestContext } from './api-request.js';

/** Internal, versioned runner boundary; deliberately absent from the public library facade. */
export const runnerIntegration = Object.freeze({
  version: 13,
  captureFailureContextSnapshot(version: number, page: object, timeoutMilliseconds: number): Promise<string> {
    if (version !== 13) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return runTraceInternal(() => captureFailureContextSnapshot(page, timeoutMilliseconds));
  },
  installArtifactRequestLifecycle(version: number, lifecycle: ArtifactRequestLifecycle): RunnerRequestLifecycleRegistration {
    if (version !== 12) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return installArtifactRequestLifecycle(lifecycle);
  },
  requestTraceOwner(version: number, context: APIRequestContext): object {
    if (version !== 12) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return runnerRequestTraceOwner(context);
  },
  beginTraceRecordingChunk(version: number, tracing: object, recording: RunnerTraceRecording, observer: RunnerActionObserver, options: TracingChunkOptions = {}): ReturnType<typeof beginRunnerTraceRecordingChunk> {
    if (version !== 11) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return beginRunnerTraceRecordingChunk(tracing, recording, observer, options);
  },
  discardTraceChunk(version: number, tracing: object, chunk: RunnerTraceChunk): Promise<void> {
    if (version !== 11) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return discardRunnerTraceChunk(tracing, chunk);
  },
  settleClosedTraceCleanup(version: number, tracing: object): Promise<void> {
    if (version !== 11) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return settleClosedRunnerTraceCleanup(tracing);
  },
  beginTraceRecordingWithActions(version: number, tracing: object, options: TracingStartOptions, observer: RunnerActionObserver): RunnerTraceStartup {
    if (version !== 11) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return beginRunnerTraceRecordingWithActions(tracing, options, observer);
  },
  startTraceRecordingWithActions(version: number, tracing: object, options: TracingStartOptions, observer: RunnerActionObserver): Promise<RunnerTraceRecordingWithActions> {
    if (version !== 10) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return startRunnerTraceRecordingWithActions(tracing, options, observer);
  },
  installArtifactContextLifecycle(version: number, lifecycle: ArtifactContextLifecycle): RunnerContextLifecycleRegistration {
    if (version !== 9) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return installArtifactContextLifecycle(lifecycle);
  },
  installOwnedContextLifecycle(version: number, lifecycle: OwnedRunnerContextLifecycle): RunnerContextLifecycleRegistration {
    if (version !== 8) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return installOwnedRunnerContextLifecycle(lifecycle);
  },
  startTraceRecording(version: number, tracing: object, options: TracingStartOptions): Promise<RunnerTraceRecording> {
    if (version !== 7) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return startRunnerTraceRecording(tracing, options);
  },
  currentTraceRecording(version: number, tracing: object): RunnerTraceRecording | undefined {
    if (version !== 7) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return currentRunnerTraceRecording(tracing);
  },
  beginTraceJournal(version: number, context: unknown, options: RunnerTraceJournalOptions): RunnerTraceJournal {
    if (version !== 6) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return RunnerTraceJournal.begin(context, options);
  },
  createTraceJournal(version: number, context: unknown, options: RunnerTraceJournalOptions): Promise<RunnerTraceJournal> {
    if (version !== 5) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return RunnerTraceJournal.create(context, options);
  },
  createTraceArchiveAssembly(version: number): TraceArchiveAssembly {
    if (version !== 4) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return new TraceArchiveAssembly();
  },
  currentTraceChunk(version: number, tracing: object): RunnerTraceChunk | undefined {
    if (version !== 3) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return currentRunnerTraceChunk(tracing);
  },
  installSourcePositionMapper(version: number, mapper: SourcePositionMapper): () => void {
    if (version !== 1) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return installSourcePositionMapper(mapper);
  },
  runInternal<Value>(version: number, callback: () => Value): Value {
    if (version !== 1) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return runTraceInternal(callback);
  },
  installContextLifecycle(version: number, lifecycle: RunnerContextLifecycle): () => void {
    if (version !== 1) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return installRunnerContextLifecycle(lifecycle);
  },
  installAsyncContextLifecycle(version: number, lifecycle: AsyncRunnerContextLifecycle): RunnerContextLifecycleRegistration {
    if (version !== 2) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return installAsyncRunnerContextLifecycle(lifecycle);
  },
  installActionObserver(version: number, observer: RunnerActionObserver): () => void {
    if (version !== 2) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return installRunnerActionObserver(observer);
  },
  installContextDefaults(version: number, defaults: RunnerContextDefaults): () => void {
    if (version !== 1) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return installRunnerContextDefaults(defaults);
  },
});
