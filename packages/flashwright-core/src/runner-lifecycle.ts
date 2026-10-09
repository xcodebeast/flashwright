import type { BrowserContext } from './index.js';
import { failure } from './errors.js';
import { publicBrowserContexts } from './public-browsers.js';

export interface RunnerContextLifecycle {
  didCreateContext(context: BrowserContext): void;
  willCloseContext(context: BrowserContext): Promise<void>;
}

let activeLifecycle: RunnerContextLifecycle | undefined;

/** Observe public host objects only; privately prepared native contexts never enter this boundary. */
export function installRunnerContextLifecycle(lifecycle: RunnerContextLifecycle): () => void {
  if (activeLifecycle) throw failure('ProtocolError', 'runner.integration', 'a runner context-lifecycle observer is already active');
  if (!lifecycle || typeof lifecycle.didCreateContext !== 'function' || typeof lifecycle.willCloseContext !== 'function') {
    throw failure('ProtocolError', 'runner.integration', 'invalid runner context-lifecycle observer');
  }
  const observedContexts = new WeakSet<BrowserContext>();
  const installed: RunnerContextLifecycle = {
    didCreateContext(context) {
      if (observedContexts.has(context)) return;
      observedContexts.add(context);
      lifecycle.didCreateContext(context);
    },
    willCloseContext: context => lifecycle.willCloseContext(context),
  };
  activeLifecycle = installed;
  try { for (const context of publicBrowserContexts()) installed.didCreateContext(context); }
  catch (error) { activeLifecycle = undefined; throw error; }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (activeLifecycle !== installed) throw failure('ProtocolError', 'runner.integration', 'runner context-lifecycle ownership changed before teardown');
    activeLifecycle = undefined;
  };
}

export function didCreateRunnerContext(context: BrowserContext): void {
  activeLifecycle?.didCreateContext(context);
}

/** Undefined preserves the ordinary close path without adding an asynchronous stage. */
export function willCloseRunnerContext(context: BrowserContext): Promise<void> | undefined {
  return activeLifecycle?.willCloseContext(context);
}
