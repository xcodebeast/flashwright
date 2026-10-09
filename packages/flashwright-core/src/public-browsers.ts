import type { Browser, BrowserContext } from './index.js';

const browsers = new Set<WeakRef<Browser>>();
const finalizedBrowsers = new FinalizationRegistry<WeakRef<Browser>>(reference => { browsers.delete(reference); });

/** Published host browsers only: private native preparation has no object to register. */
export function registerPublicBrowser(browser: Browser): () => void {
  const reference = new WeakRef(browser);
  browsers.add(reference);
  finalizedBrowsers.register(browser, reference, reference);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    browsers.delete(reference);
    finalizedBrowsers.unregister(reference);
  };
}

/** Weak enumeration also prunes stale entries before finalization callbacks have run. */
export function publicBrowserContexts(): BrowserContext[] {
  const contexts: BrowserContext[] = [];
  for (const reference of browsers) {
    const browser = reference.deref();
    if (browser) contexts.push(...browser.contexts());
    else { browsers.delete(reference); finalizedBrowsers.unregister(reference); }
  }
  return contexts;
}
