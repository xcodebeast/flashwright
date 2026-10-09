import { runTraceInternal } from './trace-hooks.js';
import { installSourcePositionMapper, type SourcePositionMapper } from './call-sites.js';
import { failure } from './errors.js';
import { installRunnerContextLifecycle, installAsyncRunnerContextLifecycle, installOwnedRunnerContextLifecycle, type RunnerContextLifecycle, type AsyncRunnerContextLifecycle, type OwnedRunnerContextLifecycle, type RunnerContextLifecycleRegistration } from './runner-lifecycle.js';
import { installRunnerContextDefaults, type RunnerContextDefaults } from './runner-context-defaults.js';
import { installRunnerActionObserver, type RunnerActionObserver } from './runner-actions.js';
import { currentRunnerTraceChunk, currentRunnerTraceRecording, startRunnerTraceRecording, type RunnerTraceChunk, type RunnerTraceRecording } from './runner-trace-archives.js';
import type { TracingStartOptions } from './tracing.js';
import { TraceArchiveAssembly } from './trace-archive-assembly.js';
import { RunnerTraceJournal, type RunnerTraceJournalOptions } from './runner-trace-journal.js';

/** Internal, versioned runner boundary; deliberately absent from the public library facade. */
export const runnerIntegration = Object.freeze({
  version: 8,
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
