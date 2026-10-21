import { FixtureConfigurationError, FixturePool, type FixtureFunction, type FixtureRegistration, type FixtureScope, type FixtureValues } from './fixture-pool.js';

type AutomaticScope = 'test' | 'all-hooks-only' | 'worker';
export type FixtureRunResult<T> = { ran: true; value: T } | { ran: false };
interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
interface Instance {
  registration: FixtureRegistration;
  value: unknown;
  failed: boolean;
  release: Deferred<void> | undefined;
  completion: Promise<void> | undefined;
  teardownFailure: { error: unknown } | undefined;
}
type Instances = Map<FixtureRegistration, Instance>;

function sameRegistration(a: FixtureRegistration | undefined, b: FixtureRegistration | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.name === b.name && Object.is(a.value, b.value) && a.scope === b.scope && a.auto === b.auto && a.option === b.option && sameRegistration(a.previous, b.previous);
}

function addErrors(errors: unknown[], error: unknown): void {
  if (error instanceof AggregateError) errors.push(...error.errors);
  else errors.push(error);
}
async function retire(instances: Instances): Promise<void> {
  const errors: unknown[] = [];
  // Instances are inserted after their dependencies, so reverse creation order
  // releases every consumer while the values it depends on still exist.
  for (const [registration, instance] of [...instances].reverse()) {
    instance.release?.resolve();
    await instance.completion;
    if (instance.teardownFailure) errors.push(instance.teardownFailure.error);
    instances.delete(registration);
  }
  if (errors.length) throw new AggregateError(errors, 'Fixture teardown failed');
}

/** Owns finite fixture phases. Deadline/cancellation admission belongs to the
 * future process worker; this module neither races away callbacks nor reports
 * their resources closed while those callbacks remain pending. */
export class FixtureWorker {
  readonly #pool: FixturePool;
  readonly #info: unknown;
  readonly #instances: Instances = new Map();
  #attempt: FixtureAttempt | undefined;
  #closure: Promise<void> | undefined;
  constructor(pool: FixturePool, workerInfo: unknown) { pool.validate(); this.#pool = pool; this.#info = workerInfo; }
  beginAttempt(info: unknown, pool = this.#pool): FixtureAttempt {
    if (this.#closure) throw new FixtureConfigurationError('Fixture worker is closing');
    if (this.#attempt) throw new FixtureConfigurationError('Previous test fixture scope has not closed');
    this.validatePool(pool);
    const workers = this.#pool.registrations().filter(r => r.scope === 'worker');
    const identities = new Map<FixtureRegistration, FixtureRegistration>();
    for (const original of workers) {
      let current = pool.resolve(original.name), canonical: FixtureRegistration | undefined = original;
      while (current && canonical) { identities.set(current, canonical); current = current.previous; canonical = canonical.previous; }
    }
    const attempt = new FixtureAttempt(pool, info, this.#info, this.#instances, identities, () => { if (this.#attempt === attempt) this.#attempt = undefined; });
    this.#attempt = attempt;
    return attempt;
  }
  validatePool(pool: FixturePool): void {
    pool.validate();
    const workers = this.#pool.registrations().filter(r => r.scope === 'worker');
    const incoming = pool.registrations().filter(r => r.scope === 'worker');
    if (workers.length !== incoming.length || workers.some(r => !sameRegistration(pool.resolve(r.name), r))) throw new FixtureConfigurationError('Changed worker fixtures require a fresh worker');
  }
  close(): Promise<void> {
    if (!this.#closure) this.#closure = this.finish();
    return this.#closure;
  }
  private async finish(): Promise<void> {
    const errors: unknown[] = [];
    try { await this.#attempt?.close(); } catch (error) { addErrors(errors, error); }
    try { await retire(this.#instances); } catch (error) { addErrors(errors, error); }
    if (errors.length) throw new AggregateError(errors, 'Worker fixture teardown failed');
  }
}

export class FixtureAttempt {
  readonly #pool: FixturePool;
  readonly #testInfo: unknown;
  readonly #workerInfo: unknown;
  readonly #workerInstances: Instances;
  readonly #workerIdentities: ReadonlyMap<FixtureRegistration, FixtureRegistration>;
  readonly #testInstances: Instances = new Map();
  readonly #onClosed: () => void;
  #operation: Promise<unknown> | undefined;
  #closure: Promise<void> | undefined;
  constructor(pool: FixturePool, testInfo: unknown, workerInfo: unknown, workerInstances: Instances, workerIdentities: ReadonlyMap<FixtureRegistration, FixtureRegistration>, onClosed: () => void) {
    this.#pool = pool; this.#testInfo = testInfo; this.#workerInfo = workerInfo;
    this.#workerInstances = workerInstances; this.#workerIdentities = workerIdentities; this.#onClosed = onClosed;
  }
  run<T>(callback: (values: FixtureValues, info: unknown) => T, automatic: AutomaticScope = 'test'): Promise<FixtureRunResult<Awaited<T>>> {
    if (this.#closure) return Promise.reject(new FixtureConfigurationError('Test fixture scope is closing'));
    if (this.#operation) return Promise.reject(new FixtureConfigurationError('Concurrent fixture callbacks require separate test scopes'));
    const operation = Promise.resolve().then(() => this.invoke(callback, automatic));
    this.#operation = operation;
    // Observe both outcomes without replacing the callback's rejection or
    // creating an unhandled finally-promise when the caller fails.
    void operation.then(() => { this.#operation = undefined; }, () => { this.#operation = undefined; });
    return operation;
  }
  close(): Promise<void> {
    if (!this.#closure) this.#closure = this.finish();
    return this.#closure;
  }
  private async finish(): Promise<void> {
    try {
      // The caller retains the test/setup error. Cleanup waits for its exact
      // invocation, then reports only cleanup failures through this promise.
      await this.#operation?.catch(() => {});
      await retire(this.#testInstances);
    } finally { this.#onClosed(); }
  }
  private identity(registration: FixtureRegistration): FixtureRegistration { return registration.scope === 'worker' ? this.#workerIdentities.get(registration)! : registration; }
  private instances(scope: FixtureScope): Instances { return scope === 'worker' ? this.#workerInstances : this.#testInstances; }
  private async invoke<T>(callback: (values: FixtureValues, info: unknown) => T, automatic: AutomaticScope): Promise<FixtureRunResult<Awaited<T>>> {
    const required = this.#pool.required(callback);
    const autos = this.#pool.registrations().filter(r => r.auto && (automatic === 'test' || r.scope === 'worker' || (automatic === 'all-hooks-only' && r.auto === 'all-hooks-included')));
    autos.sort((a, b) => Number(a.scope === 'test') - Number(b.scope === 'test'));
    const ordered = new Set<FixtureRegistration>();
    const collect = (registration: FixtureRegistration): void => {
      if (ordered.has(registration)) return;
      for (const name of registration.dependencies) collect(this.#pool.resolve(name, registration)!);
      ordered.add(registration);
    };
    for (const registration of [...autos, ...required]) collect(registration);
    for (const registration of ordered) await this.setup(registration);
    const values: FixtureValues = Object.create(null) as FixtureValues;
    for (const registration of required) {
      const instance = this.instances(registration.scope).get(this.identity(registration))!;
      if (instance.failed) return { ran: false };
      values[registration.name] = instance.value;
    }
    return { ran: true, value: await callback(values, this.#testInfo) };
  }
  private async setup(registration: FixtureRegistration): Promise<void> {
    const instances = this.instances(registration.scope);
    if (instances.has(this.identity(registration))) return;
    const instance: Instance = { registration, value: registration.value, failed: false, release: undefined, completion: undefined, teardownFailure: undefined };
    instances.set(this.identity(registration), instance);
    if (typeof registration.value !== 'function') return;
    const values: FixtureValues = Object.create(null) as FixtureValues;
    for (const name of registration.dependencies) {
      const dependency = this.#pool.resolve(name, registration)!;
      const upstream = this.instances(dependency.scope).get(this.identity(dependency))!;
      if (upstream.failed) { instance.failed = true; return; }
      values[name] = upstream.value;
    }
    const available = deferred<void>();
    let used = false;
    const use = async (value?: unknown): Promise<void> => {
      if (used) throw new FixtureConfigurationError(`Fixture "${registration.name}" called use() more than once`);
      used = true; instance.value = value; instance.release = deferred<void>();
      available.resolve();
      await instance.release.promise;
    };
    const info = registration.scope === 'worker' ? this.#workerInfo : this.#testInfo;
    instance.completion = (async () => {
      try {
        await (registration.value as FixtureFunction)(values, use, info);
        if (!used) throw new FixtureConfigurationError(`Fixture "${registration.name}" completed without use()`);
      } catch (error) {
        instance.failed = true;
        if (!used) available.reject(error);
        else instance.teardownFailure = { error };
      }
    })();
    await available.promise;
  }
}
