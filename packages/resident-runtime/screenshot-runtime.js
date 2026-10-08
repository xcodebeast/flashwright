/** Retain restoration and geometry access in the same isolated document as preparation. */
function createScreenshotCapture(options) {
  let style = '';
  for (let offset = 0; offset < options.styleUnits.length; offset += 8192)
    style += String.fromCharCode(...options.styleUnits.slice(offset, offset + 8192));
  const expired = options.deadline !== null && Date.now() >= options.deadline;
  const restore = expired ? () => {} : inPagePrepareForScreenshots(style, options.hideCaret, options.disableAnimations, false);
  return {
    restore,
    async waitForFonts() { await document.fonts?.ready; return true; },
  };
}

/** Geometry follows the current document; preparation cleanup stays bound to its original realm. */
function screenshotDocumentSize(fullPage) {
  if (!fullPage) return { width: innerWidth, height: innerHeight };
  if (!document.body || !document.documentElement) return null;
  const body = document.body;
  const root = document.documentElement;
  return {
    width: Math.max(body.scrollWidth, root.scrollWidth, body.offsetWidth, root.offsetWidth, body.clientWidth, root.clientWidth),
    height: Math.max(body.scrollHeight, root.scrollHeight, body.offsetHeight, root.offsetHeight, body.clientHeight, root.clientHeight),
  };
}
