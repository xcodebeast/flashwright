import { AsyncLocalStorage } from 'node:async_hooks';
import { types } from 'node:util';
import type { APIRequestContext } from './api-request.js';
import { failure } from './errors.js';

export interface RunnerRequestCreationOwner {
  didCreateContext(context: APIRequestContext): Promise<void>;
  complete(): void | Promise<void>;
}

export interface ArtifactRequestLifecycle {
  beginRequestCreation(): RunnerRequestCreationOwner;
  didCreateUnclaimedContext(context: APIRequestContext): void;
  willDisposeContext(context: APIRequestContext): Promise<void>;
  didCloseContext(context: APIRequestContext): Promise<void>;
}

export interface RunnerRequestLifecycleRegistration {
  readonly ready: Promise<void>;
  dispose(): Promise<void>;
}

interface Registration {
  readonly lifecycle: ArtifactRequestLifecycle;
  readonly pending: Set<Promise<void>>;
  readonly observed: WeakSet<APIRequestContext>;
  readonly enrollments: WeakMap<APIRequestContext, Promise<void>>;
  readonly disposals: WeakMap<APIRequestContext, Promise<void>>;
  readonly closures: WeakSet<APIRequestContext>;
  disposing: boolean;
  failure?: { error: unknown };
}

export interface RequestCreationClaim {
  readonly registration: Registration | undefined;
  readonly owner: RunnerRequestCreationOwner | undefined;
  complete(): void;
}

const publicContexts = new Set<APIRequestContext>();
const callbackScope = new AsyncLocalStorage<Registration>();
let activeRegistration: Registration | undefined;

export function assertRunnerRequestDisposeAllowed(): void {
  if (callbackScope.getStore()) throw failure('ProtocolError', 'runner.request', 'request context disposal cannot run recursively inside its artifact lifecycle callback');
}

function own(registration: Registration, work: Promise<void>): Promise<void> {
  registration.pending.add(work);
  void work.then(() => registration.pending.delete(work), () => registration.pending.delete(work));
  return work;
}

function notifyUnclaimed(registration: Registration, context: APIRequestContext): void {
  try {
    const result: unknown = callbackScope.run(registration, () => registration.lifecycle.didCreateUnclaimedContext(context));
    if (result !== undefined) {
      if (types.isPromise(result)) own(registration, result.then(() => {}, () => {}));
      throw failure('ProtocolError', 'runner.request', 'unclaimed request context notification must complete synchronously');
    }
  } catch (error) { registration.failure ??= { error }; }
}

/** Reserve the original runner attempt before request options or storage files can await. */
export function beginRunnerRequestCreation(): RequestCreationClaim {
  if (callbackScope.getStore()) throw failure('ProtocolError', 'runner.request', 'request context creation cannot run recursively inside its artifact lifecycle callback');
  const registration = activeRegistration;
  if (!registration) return { registration: undefined, owner: undefined, complete() {} };
  if (registration.disposing) throw failure('ProtocolError', 'runner.request', 'request lifecycle is retiring');
  const owner = callbackScope.run(registration, () => registration.lifecycle.beginRequestCreation());
  if (!owner || typeof owner.didCreateContext !== 'function' || typeof owner.complete !== 'function') {
    throw failure('ProtocolError', 'runner.request', 'invalid request creation owner');
  }
  let release!: () => void;
  own(registration, new Promise<void>(resolve => { release = resolve; }));
  let completed = false;
  return {
    registration,
    owner,
    complete() {
      if (completed) return;
      completed = true;
      try {
        const completion = callbackScope.run(registration, () => Promise.resolve(owner.complete()));
        own(registration, completion.then(() => {}, error => { registration.failure ??= { error }; }));
      } catch (error) { registration.failure ??= { error }; }
      finally { release(); }
    },
  };
}

/** Publication remains tied to the creation claim even if another test begins. */
export async function publishRunnerRequestContext(context: APIRequestContext, claim: RequestCreationClaim): Promise<void> {
  publicContexts.add(context);
  const registration = activeRegistration;
  if (!registration || registration.disposing && claim.registration !== registration) return;
  if (registration.observed.has(context)) return;
  registration.observed.add(context);
  if (claim.registration !== registration || !claim.owner) {
    notifyUnclaimed(registration, context);
    return;
  }
  const enrollment = own(registration, Promise.resolve().then(() => callbackScope.run(registration, () => claim.owner!.didCreateContext(context))));
  registration.enrollments.set(context, enrollment);
  try { await enrollment; } catch (error) { registration.failure ??= { error }; }
}

/** A caller closes admission before native removal while exact trace cleanup still owns its context. */
export async function beforeRunnerRequestDispose(context: APIRequestContext): Promise<void> {
  const registration = activeRegistration;
  if (!registration || !registration.observed.has(context)) return;
  let disposal = registration.disposals.get(context);
  if (!disposal) {
    disposal = own(registration, (async () => {
      await registration.enrollments.get(context)?.catch(() => {});
      await callbackScope.run(registration, () => registration.lifecycle.willDisposeContext(context));
    })());
    registration.disposals.set(context, disposal);
  }
  try { await disposal; } catch (error) { registration.failure ??= { error }; }
}

/** Transport loss closes the exact owner even when no explicit dispose was called. */
export function notifyRunnerRequestClosed(context: APIRequestContext): void {
  publicContexts.delete(context);
  const registration = activeRegistration;
  if (!registration || registration.closures.has(context) || !registration.observed.has(context)) return;
  registration.closures.add(context);
  const closure = own(registration, (async () => {
    await registration.enrollments.get(context)?.catch(() => {});
    await registration.disposals.get(context)?.catch(() => {});
    await callbackScope.run(registration, () => registration.lifecycle.didCloseContext(context));
  })());
  void closure.catch(error => { registration.failure ??= { error }; });
}

export function installArtifactRequestLifecycle(lifecycle: ArtifactRequestLifecycle): RunnerRequestLifecycleRegistration {
  if (activeRegistration) throw failure('ProtocolError', 'runner.request', 'a request lifecycle observer is already active');
  if (!lifecycle || typeof lifecycle.beginRequestCreation !== 'function' || typeof lifecycle.didCreateUnclaimedContext !== 'function' || typeof lifecycle.willDisposeContext !== 'function' || typeof lifecycle.didCloseContext !== 'function') {
    throw failure('ProtocolError', 'runner.request', 'invalid request lifecycle observer');
  }
  const registration: Registration = { lifecycle, pending: new Set(), observed: new WeakSet(), enrollments: new WeakMap(), disposals: new WeakMap(), closures: new WeakSet(), disposing: false };
  activeRegistration = registration;
  const existing = [...publicContexts].map(context => {
    try {
      const claim = beginRunnerRequestCreation();
      return publishRunnerRequestContext(context, claim).finally(() => claim.complete());
    } catch (error) { registration.failure ??= { error }; return Promise.resolve(); }
  });
  const ready = Promise.all(existing).then(() => {
    if (registration.failure) throw registration.failure.error;
  });
  void ready.catch(() => {});
  let disposal: Promise<void> | undefined;
  return {
    ready,
    dispose() {
      if (callbackScope.getStore() === registration) return Promise.reject(failure('ProtocolError', 'runner.request', 'request lifecycle disposal cannot run recursively inside its callback'));
      registration.disposing = true;
      disposal ??= (async () => {
        while (registration.pending.size) await Promise.allSettled([...registration.pending]);
        if (activeRegistration !== registration) throw failure('ProtocolError', 'runner.request', 'request lifecycle ownership changed before teardown');
        activeRegistration = undefined;
        if (registration.failure) throw registration.failure.error;
      })();
      return disposal;
    },
  };
}
