import type { BrowserContext } from './index.js';
import { failure } from './errors.js';
import { publicBrowserContexts } from './public-browsers.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { types } from 'node:util';

export type RunnerContextCloseSource = 'context' | 'browser';

export interface RunnerContextLifecycle {
  didCreateContext(context: BrowserContext): void;
  willCloseContext(context: BrowserContext, source?: RunnerContextCloseSource): Promise<void>;
}

export interface AsyncRunnerContextLifecycle {
  didCreateContext(context: BrowserContext): Promise<void>;
  willCloseContext(context: BrowserContext, source?: RunnerContextCloseSource): Promise<void>;
}

export interface RunnerContextCreationOwner {
  didCreateContext(context: BrowserContext): Promise<void>;
  /** Bookkeeping failures are reported by registration disposal, preserving the creation outcome. */
  complete(): void | Promise<void>;
}

export interface OwnedRunnerContextLifecycle {
  beginContextCreation(): RunnerContextCreationOwner;
  willCloseContext(context: BrowserContext, source?: RunnerContextCloseSource): Promise<void>;
}

export interface ArtifactContextLifecycle extends OwnedRunnerContextLifecycle {
  /** Observe availability synchronously without assigning a creation to a later attempt. */
  didCreateUnclaimedContext(context: BrowserContext): void;
}

export interface RunnerContextLifecycleRegistration {
  readonly ready: Promise<void>;
  dispose(): Promise<void>;
}

interface InstalledLifecycle {
  beginContextCreation?(): RunnerContextCreationOwner;
  didCreateContext(context: BrowserContext, owner?: RunnerContextCreationOwner): Promise<void> | void;
  willCloseContext(context: BrowserContext, source?: RunnerContextCloseSource): Promise<void>;
  didCreateUnclaimedContext?(context: BrowserContext): void;
}

type ContextCreation = null | number | { generation: number; owner: RunnerContextCreationOwner };

let activeLifecycle: InstalledLifecycle | undefined;
let lifecycleGeneration = 0;
export function runnerContextLifecycleActive(): boolean { return activeLifecycle !== undefined; }
// A surviving context must not retain a retired observer and its test artifacts.
const enrollmentOwners = new WeakMap<BrowserContext, number>();
const callbackScope = new AsyncLocalStorage<InstalledLifecycle>();

/** Claim the calling scope before any native allocation or asynchronous option preparation. */
export function beginRunnerContextCreation(): ContextCreation {
  if (callbackScope.getStore()) throw failure('ProtocolError', 'runner.integration', 'context creation cannot run recursively inside a runner lifecycle callback');
  if (!activeLifecycle) return null;
  if (activeLifecycle?.beginContextCreation) return { generation: lifecycleGeneration, owner: activeLifecycle.beginContextCreation() };
  return lifecycleGeneration;
}

/** Native creation and failure cleanup retain the original attempt even after its public timeout. */
export function completeRunnerContextCreation(creation: ContextCreation): void {
  if (creation !== null && typeof creation !== 'number') creation.owner.complete();
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
      callbackScope.run(installed, () => lifecycle.didCreateContext(context));
    },
    willCloseContext: (context, source) => callbackScope.run(installed, () => lifecycle.willCloseContext(context, source)),
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
  return installAsyncLifecycle(lifecycle);
}

/** Capture attempt ownership before any asynchronous context work, not at its eventual reply. */
export function installOwnedRunnerContextLifecycle(lifecycle: OwnedRunnerContextLifecycle): RunnerContextLifecycleRegistration {
  if (!lifecycle || typeof lifecycle.beginContextCreation !== 'function') throw failure('ProtocolError', 'runner.integration', 'invalid runner context-creation observer');
  return installAsyncLifecycle(lifecycle, lifecycle.beginContextCreation);
}

/** Optional artifacts distinguish pre-observer creation from an original attempt's owned claim. */
export function installArtifactContextLifecycle(lifecycle: ArtifactContextLifecycle): RunnerContextLifecycleRegistration {
  if (!lifecycle || typeof lifecycle.beginContextCreation !== 'function' || typeof lifecycle.didCreateUnclaimedContext !== 'function') {
    throw failure('ProtocolError', 'runner.integration', 'invalid artifact context-lifecycle observer');
  }
  return installAsyncLifecycle(lifecycle, lifecycle.beginContextCreation, lifecycle.didCreateUnclaimedContext);
}

function installAsyncLifecycle(lifecycle: AsyncRunnerContextLifecycle | OwnedRunnerContextLifecycle, beginCreation?: () => RunnerContextCreationOwner, unclaimedNotification?: (context: BrowserContext) => void): RunnerContextLifecycleRegistration {
  if (activeLifecycle) throw failure('ProtocolError', 'runner.integration', 'a runner context-lifecycle observer is already active');
  if (!lifecycle || typeof lifecycle.willCloseContext !== 'function' ||
      (beginCreation === undefined ? !('didCreateContext' in lifecycle) || typeof lifecycle.didCreateContext !== 'function' : typeof beginCreation !== 'function')) {
    throw failure('ProtocolError', 'runner.integration', 'invalid runner context-lifecycle observer');
  }
  const enrollments = new WeakMap<BrowserContext, Promise<void>>();
  const closingContexts = new WeakSet<BrowserContext>();
  const pending = new Set<Promise<void>>();
  let disposing = false;
  let disposal: Promise<void> | undefined;
  let completionFailure: { error: unknown } | undefined;
  const own = (work: Promise<void>): Promise<void> => {
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  const installed: InstalledLifecycle = {
    ...(unclaimedNotification ? { didCreateUnclaimedContext(context: BrowserContext) {
      // Creation began before observation existed. Retirement cannot reject it or
      // open new capture; a future scope can explicitly adopt the surviving context.
      if (disposing || enrollments.has(context)) return;
      enrollmentOwners.set(context, lifecycleGeneration);
      enrollments.set(context, Promise.resolve());
      try {
        const result: unknown = callbackScope.run(installed, () => unclaimedNotification.call(lifecycle, context));
        if (result !== undefined) {
          if (types.isPromise(result)) own(result.then(() => {}, () => {}));
          throw failure('ProtocolError', 'runner.integration', 'unclaimed context notification must complete synchronously without a return value');
        }
      } catch (error) { completionFailure ??= { error }; }
    } } : {}),
    ...(beginCreation ? { beginContextCreation: () => {
      if (disposing) throw failure('ProtocolError', 'runner.integration', 'runner context-lifecycle observer is retiring');
      let original: RunnerContextCreationOwner | undefined = callbackScope.run(installed, () => beginCreation.call(lifecycle));
      if (!original || typeof original.didCreateContext !== 'function' || typeof original.complete !== 'function') throw failure('ProtocolError', 'runner.integration', 'invalid runner context-creation owner');
      let settled!: () => void;
      own(new Promise<void>(resolve => { settled = resolve; }));
      return {
        didCreateContext: (context: BrowserContext) => {
          if (!original) throw failure('ProtocolError', 'runner.integration', 'runner context-creation owner already completed');
          return original.didCreateContext(context);
        },
        complete() {
          const owner = original;
          if (!owner) return;
          original = undefined;
          try {
            const completion = callbackScope.run(installed, () => Promise.resolve(owner.complete()));
            void completion.then(settled, error => { completionFailure ??= { error }; settled(); });
          } catch (error) { completionFailure ??= { error }; settled(); }
        },
      };
    } } : {}),
    didCreateContext(context, owner) {
      const previous = enrollments.get(context);
      if (previous) return previous;
      if (disposing) throw failure('ProtocolError', 'runner.integration', 'runner context-lifecycle observer is retiring');
      const creation = owner ?? installed.beginContextCreation?.();
      enrollmentOwners.set(context, lifecycleGeneration);
      // Publish ownership before invoking a callback that may enumerate the same context.
      const enrollment = Promise.resolve().then(() => callbackScope.run(installed, () => creation
        ? creation.didCreateContext(context)
        : (lifecycle as AsyncRunnerContextLifecycle).didCreateContext(context))).then(() => {
        if (closingContexts.has(context) || !context.browser().contexts().includes(context)) {
          throw failure('TargetClosedError', 'browser.newContext', 'context closed while runner artifacts were starting');
        }
      }).finally(() => { if (!owner) creation?.complete(); });
      enrollments.set(context, enrollment);
      return own(enrollment);
    },
    willCloseContext(context, source) {
      closingContexts.add(context);
      return own((async () => {
        // Failed startup still gets the close callback; its error belongs to the original creator.
        await enrollments.get(context)?.catch(() => {});
        await callbackScope.run(installed, () => lifecycle.willCloseContext(context, source));
      })());
    },
  };
  activeLifecycle = installed;
  lifecycleGeneration++;
  const dispose = (): Promise<void> => {
    if (callbackScope.getStore() === installed) return Promise.reject(failure('ProtocolError', 'runner.integration', 'observer disposal cannot run recursively inside its lifecycle callback'));
    disposing = true;
    disposal ??= (async () => {
      // Claims cover native creation too; its failure can initiate a close callback.
      while (pending.size) await Promise.allSettled([...pending]);
      if (activeLifecycle !== installed) throw failure('ProtocolError', 'runner.integration', 'runner context-lifecycle ownership changed before teardown');
      activeLifecycle = undefined;
      lifecycleGeneration++;
      if (completionFailure) throw completionFailure.error;
    })();
    return disposal;
  };
  const existing = publicBrowserContexts().map(context => {
    try { return installed.didCreateContext(context); }
    catch (error) { return Promise.reject(error); }
  });
  const ready = Promise.allSettled(existing).then(async results => {
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') { await dispose().catch(() => {}); throw rejected.reason; }
  });
  // Registration remains a real owner even when its caller is interrupted before awaiting ready.
  void ready.catch(() => {});
  return { ready, dispose };
}

/** Undefined leaves the ordinary creation path free of an extra asynchronous stage. */
export function didCreateRunnerContext(context: BrowserContext, creation: ContextCreation = lifecycleGeneration): Promise<void> | void {
  if (creation === null) {
    if (!activeLifecycle) return;
    if (activeLifecycle.didCreateUnclaimedContext) return activeLifecycle.didCreateUnclaimedContext(context);
    throw failure('TargetClosedError', 'browser.newContext', 'runner scope changed while the context was being created');
  }
  const generation = typeof creation === 'number' ? creation : creation.generation;
  if (generation !== lifecycleGeneration) throw failure('TargetClosedError', 'browser.newContext', 'runner scope changed while the context was being created');
  return activeLifecycle?.didCreateContext(context, typeof creation === 'number' ? undefined : creation.owner);
}

/** Undefined preserves the ordinary close path without adding an asynchronous stage. */
export function willCloseRunnerContext(context: BrowserContext, source: RunnerContextCloseSource = 'context'): Promise<void> | undefined {
  return enrollmentOwners.get(context) === lifecycleGeneration ? activeLifecycle?.willCloseContext(context, source) : undefined;
}
