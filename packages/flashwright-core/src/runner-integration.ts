import { runTraceInternal } from './trace-hooks.js';
import { installSourcePositionMapper, type SourcePositionMapper } from './call-sites.js';
import { failure } from './errors.js';
import { installRunnerContextLifecycle, installAsyncRunnerContextLifecycle, type RunnerContextLifecycle, type AsyncRunnerContextLifecycle, type RunnerContextLifecycleRegistration } from './runner-lifecycle.js';
import { installRunnerContextDefaults, type RunnerContextDefaults } from './runner-context-defaults.js';
import { installRunnerActionObserver, type RunnerActionObserver } from './runner-actions.js';
import { currentRunnerTraceChunk, type RunnerTraceChunk } from './runner-trace-archives.js';
import { TraceArchiveAssembly } from './trace-archive-assembly.js';

/** Internal, versioned runner boundary; deliberately absent from the public library facade. */
export const runnerIntegration = Object.freeze({
  version: 4,
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
