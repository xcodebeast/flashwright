import type { BrowserContext } from './index.js';
import { failure } from './errors.js';
import { publicBrowserContexts } from './public-browsers.js';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RunnerContextLifecycle {
  didCreateContext(context: BrowserContext): void;
  willCloseContext(context: BrowserContext): Promise<void>;
}

export interface AsyncRunnerContextLifecycle {
  didCreateContext(context: BrowserContext): Promise<void>;
  willCloseContext(context: BrowserContext): Promise<void>;
}

export interface RunnerContextLifecycleRegistration {
  readonly ready: Promise<void>;
  dispose(): Promise<void>;
}

interface InstalledLifecycle {
  didCreateContext(context: BrowserContext): Promise<void> | void;
  willCloseContext(context: BrowserContext): Promise<void>;
}

let activeLifecycle: InstalledLifecycle | undefined;
let lifecycleGeneration = 0;
// A surviving context must not retain a retired observer and its test artifacts.
const enrollmentOwners = new WeakMap<BrowserContext, number>();
const callbackScope = new AsyncLocalStorage<InstalledLifecycle>();

/** Claim the calling scope before any native allocation or asynchronous option preparation. */
export function beginRunnerContextCreation(): number {
  if (callbackScope.getStore()) throw failure('ProtocolError', 'runner.integration', 'context creation cannot run recursively inside a runner lifecycle callback');
  return lifecycleGeneration;
}

/** Artifact callbacks must return before their creator or closer can retire that context. */
export function assertRunnerContextCloseAllowed(): void {
  if (callbackScope.getStore()) throw failure('ProtocolError', 'runner.integration', 'context closure cannot run recursively inside a runner lifecycle callback');
}

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
      enrollmentOwners.set(context, lifecycleGeneration);
      lifecycle.didCreateContext(context);
    },
    willCloseContext: context => lifecycle.willCloseContext(context),
  };
  activeLifecycle = installed;
  lifecycleGeneration++;
  try { for (const context of publicBrowserContexts()) installed.didCreateContext(context); }
  catch (error) { activeLifecycle = undefined; lifecycleGeneration++; throw error; }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (activeLifecycle !== installed) throw failure('ProtocolError', 'runner.integration', 'runner context-lifecycle ownership changed before teardown');
    activeLifecycle = undefined;
    lifecycleGeneration++;
  };
}

/** Artifact startup owns context publication and any callbacks still settling at teardown. */
export function installAsyncRunnerContextLifecycle(lifecycle: AsyncRunnerContextLifecycle): RunnerContextLifecycleRegistration {
  if (activeLifecycle) throw failure('ProtocolError', 'runner.integration', 'a runner context-lifecycle observer is already active');
  if (!lifecycle || typeof lifecycle.didCreateContext !== 'function' || typeof lifecycle.willCloseContext !== 'function') {
    throw failure('ProtocolError', 'runner.integration', 'invalid runner context-lifecycle observer');
  }
  const enrollments = new WeakMap<BrowserContext, Promise<void>>();
  const closingContexts = new WeakSet<BrowserContext>();
  const pending = new Set<Promise<void>>();
  let disposing = false;
  let disposal: Promise<void> | undefined;
  const own = (work: Promise<void>): Promise<void> => {
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  const installed: InstalledLifecycle = {
    didCreateContext(context) {
      const previous = enrollments.get(context);
      if (previous) return previous;
      if (disposing) throw failure('ProtocolError', 'runner.integration', 'runner context-lifecycle observer is retiring');
      enrollmentOwners.set(context, lifecycleGeneration);
      // Publish ownership before invoking a callback that may enumerate the same context.
      const enrollment = Promise.resolve().then(() => callbackScope.run(installed, () => lifecycle.didCreateContext(context))).then(() => {
        if (closingContexts.has(context) || !context.browser().contexts().includes(context)) {
          throw failure('TargetClosedError', 'browser.newContext', 'context closed while runner artifacts were starting');
        }
      });
      enrollments.set(context, enrollment);
      return own(enrollment);
    },
    willCloseContext(context) {
      closingContexts.add(context);
      return own((async () => {
        // Failed startup still gets the close callback; its error belongs to the original creator.
        await enrollments.get(context)?.catch(() => {});
        await callbackScope.run(installed, () => lifecycle.willCloseContext(context));
      })());
    },
  };
  activeLifecycle = installed;
  lifecycleGeneration++;
  const dispose = (): Promise<void> => {
    if (callbackScope.getStore() === installed) return Promise.reject(failure('ProtocolError', 'runner.integration', 'observer disposal cannot run recursively inside its lifecycle callback'));
    disposing = true;
    disposal ??= (async () => {
      // A settling creation can synchronously initiate its close callback.
      while (pending.size) await Promise.allSettled([...pending]);
      if (activeLifecycle !== installed) throw failure('ProtocolError', 'runner.integration', 'runner context-lifecycle ownership changed before teardown');
      activeLifecycle = undefined;
      lifecycleGeneration++;
    })();
    return disposal;
  };
  const existing = publicBrowserContexts().map(context => installed.didCreateContext(context));
  const ready = Promise.allSettled(existing).then(async results => {
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') { await dispose(); throw rejected.reason; }
  });
  // Registration remains a real owner even when its caller is interrupted before awaiting ready.
  void ready.catch(() => {});
  return { ready, dispose };
}

/** Undefined leaves the ordinary creation path free of an extra asynchronous stage. */
export function didCreateRunnerContext(context: BrowserContext, generation = lifecycleGeneration): Promise<void> | void {
  if (generation !== lifecycleGeneration) throw failure('TargetClosedError', 'browser.newContext', 'runner scope changed while the context was being created');
  return activeLifecycle?.didCreateContext(context);
}

/** Undefined preserves the ordinary close path without adding an asynchronous stage. */
export function willCloseRunnerContext(context: BrowserContext): Promise<void> | undefined {
  return enrollmentOwners.get(context) === lifecycleGeneration ? activeLifecycle?.willCloseContext(context) : undefined;
}
