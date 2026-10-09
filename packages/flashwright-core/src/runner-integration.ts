import { runTraceInternal } from './trace-hooks.js';
import { installSourcePositionMapper, type SourcePositionMapper } from './call-sites.js';
import { failure } from './errors.js';
import { installRunnerContextLifecycle, type RunnerContextLifecycle } from './runner-lifecycle.js';
import { installRunnerContextDefaults, type RunnerContextDefaults } from './runner-context-defaults.js';

/** Internal, versioned runner boundary; deliberately absent from the public library facade. */
export const runnerIntegration = Object.freeze({
  version: 1,
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
  installContextDefaults(version: number, defaults: RunnerContextDefaults): () => void {
    if (version !== 1) throw failure('ProtocolError', 'runner.integration', `unsupported runner integration version ${version}`);
    return installRunnerContextDefaults(defaults);
  },
});
