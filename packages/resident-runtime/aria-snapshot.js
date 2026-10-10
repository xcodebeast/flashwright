/* Public default snapshots use the pinned renderer, including its retained-map update. */
function captureAriaSnapshot(injected, codec, request, deadline) {
  const expired = () => deadline !== null && Date.now() >= deadline;
  if (expired()) return { status: 'expired' };
  const originalDocument = document;
  const element = request.selector === null ? originalDocument.body :
    injected.querySelector(injected.parseSelector(request.selector), originalDocument, true);
  if (!element || !element.isConnected || element.ownerDocument !== originalDocument)
    return { status: 'retry', reason: codec.encode('snapshot target is not attached') };
  const snapshot = injected.ariaSnapshot(element, { mode: 'default', depth: request.depth, boxes: request.boxes });
  if (expired()) return { status: 'expired' };
  if (document !== originalDocument || !element.isConnected || element.ownerDocument !== originalDocument)
    return { status: 'retry', reason: codec.encode('snapshot document changed') };
  // This bounds public output only. The pinned renderer has already built its temporary tree.
  if (snapshot.length > 100000) return { status: 'resourceLimit' };
  return { status: 'success', value: codec.encode(snapshot) };
}
