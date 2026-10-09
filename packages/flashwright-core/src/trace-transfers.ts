import type { EngineClient } from './client.js';

interface TransferOwners { contexts: Set<string> }
const transferOwners = new WeakMap<EngineClient, TransferOwners>();

/** Busy collectors leave payloads in their bounded native queues instead of accumulating waiters. */
export function traceTransferAvailable(client: EngineClient, context: string): boolean {
  const owners = transferOwners.get(client);
  return !owners || owners.contexts.size < 2 && !owners.contexts.has(context);
}

/** The lease covers binary transfer through immutable ingestion, including cancelled ingestion. */
export function tryAcquireTraceTransfer(client: EngineClient, context: string): (() => void) | undefined {
  let owners = transferOwners.get(client);
  if (!owners) {
    owners = { contexts: new Set() };
    transferOwners.set(client, owners);
  }
  if (owners.contexts.size >= 2 || owners.contexts.has(context)) return undefined;
  owners.contexts.add(context);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owners.contexts.delete(context);
  };
}
