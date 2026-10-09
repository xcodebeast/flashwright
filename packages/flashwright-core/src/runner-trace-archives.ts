import { failure } from './errors.js';
import type { SealedTraceArchive } from './trace-archive.js';

export interface RunnerTraceChunk {
  /** Seal this exact chunk and transfer its immutable files to the caller. */
  takeArchive(signal?: AbortSignal): Promise<SealedTraceArchive>;
}

const traceOwners = new WeakMap<object, () => RunnerTraceChunk | undefined>();

/** Keep runner access outside the public Tracing surface and its declarations. */
export function registerRunnerTraceOwner(owner: object, currentChunk: () => RunnerTraceChunk | undefined): void {
  traceOwners.set(owner, currentChunk);
}

export function currentRunnerTraceChunk(owner: object): RunnerTraceChunk | undefined {
  const currentChunk = traceOwners.get(owner);
  if (!currentChunk) throw failure('ProtocolError', 'runner.tracing', 'unknown tracing owner');
  return currentChunk();
}
