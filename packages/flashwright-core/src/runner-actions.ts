import { failure } from './errors.js';
import type { TraceLocation } from './trace-preview.js';

export interface RunnerActionMetadata {
  readonly className: string;
  readonly method: string;
  readonly apiName: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly stack: readonly TraceLocation[];
}

export interface RunnerAction {
  readonly stepId: string;
  readonly title?: string;
  complete(error: unknown): void;
}

export interface RunnerActionObserver {
  begin(metadata: RunnerActionMetadata): RunnerAction | undefined;
}

let observer: RunnerActionObserver | undefined;

/** Runner-private steps stay outside the library; each call keeps its original completion owner. */
export function installRunnerActionObserver(candidate: RunnerActionObserver): () => void {
  if (observer) throw failure('ProtocolError', 'runner.integration', 'a runner action observer is already active');
  if (!candidate || typeof candidate.begin !== 'function') throw failure('ProtocolError', 'runner.integration', 'invalid runner action observer');
  observer = candidate;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (observer !== candidate) throw failure('ProtocolError', 'runner.integration', 'runner action ownership changed before teardown');
    observer = undefined;
  };
}

export function beginRunnerAction(metadata: RunnerActionMetadata): RunnerAction | undefined {
  const action = observer?.begin(metadata);
  if (action && (typeof action.stepId !== 'string' || !action.stepId || action.stepId.length > 1024 || typeof action.complete !== 'function' || action.title !== undefined && (typeof action.title !== 'string' || action.title.length > 16384))) {
    throw failure('ProtocolError', 'runner.integration', 'invalid runner action identity or completion owner');
  }
  return action;
}
