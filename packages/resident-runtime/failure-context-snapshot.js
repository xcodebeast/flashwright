/* Failure fallback is private and does not expand public ARIA snapshot modes. */
function captureFailureContextSnapshot(injected, codec, deadline) {
  const expired = () => Date.now() >= deadline;
  if (expired()) return { status: 'expired' };
  const originalDocument = document;
  const body = originalDocument.body;
  if (!body || !body.isConnected || body.ownerDocument !== originalDocument)
    return { status: 'retry' };
  const snapshot = injected.incrementalAriaSnapshot(body, { mode: 'ai', refPrefix: '' });
  if (expired()) return { status: 'expired' };
  if (document !== originalDocument || !body.isConnected || body.ownerDocument !== originalDocument)
    return { status: 'retry' };
  if (snapshot.iframeRefs.some(reference => Object.hasOwn(snapshot.iframeDepths, reference)))
    return { status: 'unsupportedFrames' };
  const maximumCharacters = 16384;
  const notice = '\n[Page snapshot truncated: diagnostic size limit reached.]';
  let text = snapshot.full;
  if (text.length > maximumCharacters) {
    let end = maximumCharacters - notice.length;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    text = text.slice(0, end) + notice;
  }
  return { status: 'success', value: codec.encode(text) };
}
