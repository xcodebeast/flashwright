const maximumRecoveryReserve = 16;
export const minimumDialogPendingOperations = 2;

/** These commands only collect already captured native data; none wait for browser work. */
export function isTraceCollection(method: string): boolean {
  return ['context.trace.snapshot.pull', 'context.trace.snapshot.take', 'context.trace.snapshot.ingested',
    'context.trace.network.pull', 'context.trace.network.take', 'context.trace.network.ingested',
    'apiRequest.traceBody.take', 'apiRequest.traceBody.ingested', 'apiRequest.traceBody.retire'].includes(method);
}

export function isTraceCollectionTake(method: string): boolean {
  return method === 'context.trace.snapshot.take' || method === 'context.trace.network.take' || method === 'apiRequest.traceBody.take';
}

/** Keep the total negotiated bound while leaving capacity for modal handling and owner closure. */
export function operationAdmissionLimit(method: string, total: number): number {
  if (['dialog.accept', 'dialog.dismiss', 'page.dialog.subscribe', 'context.dialog.subscribe', 'page.console.subscribe', 'context.console.subscribe', 'page.close', 'context.close', 'browser.close', 'apiRequest.dispose', 'apiResponse.dispose'].includes(method)) return total;
  if (isTraceCollection(method)) return total;
  return total < minimumDialogPendingOperations ? total : total - Math.min(maximumRecoveryReserve, total - 1);
}
