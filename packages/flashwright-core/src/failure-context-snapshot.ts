import { failure } from './errors.js';

type SnapshotResolver = (page: object, timeoutMilliseconds: number) => Promise<string> | undefined;
let resolveSnapshot: SnapshotResolver | undefined;

/** Installed by the canonical Page implementation without adding a public Page method. */
export function installFailureContextSnapshotResolver(resolver: SnapshotResolver): void {
  resolveSnapshot = resolver;
}

/** Runner fallback has its own finite budget and never inherits timeout:0. */
export async function captureFailureContextSnapshot(page: object, timeoutMilliseconds: number): Promise<string> {
  if (typeof timeoutMilliseconds !== 'number' || !Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0 || timeoutMilliseconds > 5000)
    throw failure('InvalidArgumentError', 'diagnostics.pageSnapshot', 'failure snapshot timeout must be positive and at most 5000 milliseconds');
  const snapshot = resolveSnapshot?.(page, timeoutMilliseconds);
  if (!snapshot) throw failure('InvalidArgumentError', 'diagnostics.pageSnapshot', 'failure snapshot requires an owned Flashwright Page');
  return snapshot;
}
