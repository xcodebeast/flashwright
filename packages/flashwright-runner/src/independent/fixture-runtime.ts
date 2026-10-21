import { FixtureConfigurationError, FixturePool, type FixtureFunction, type FixtureRegistration, type FixtureScope, type FixtureValues } from './fixture-pool.js';
import { exhausted, inDeadlineContext, timeSlot, withDeadline, type DeadlineRun, type PhaseBudget, type TimeSlot } from './deadlines.js';

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
  slot: TimeSlot | undefined;
  run: DeadlineRun | undefined;
  setupFailure: unknown;
  acceptingUse: boolean;
  retired: boolean;
}
type Instances = Map<FixtureRegistration, Instance>;
type WorkerFixtureContext = <T>(callback: () => T) => T;

function addErrors(errors: unknown[], error: unknown): void {
  if (error instanceof AggregateError) errors.push(...error.errors);
  else errors.push(error);
}
async function retire(instances: Instances, budget?: PhaseBudget): Promise<void> {
  const errors: unknown[] = [];
  // Instances are inserted after their dependencies, so reverse creation order
  // releases every consumer while the values it depends on still exist.
  for (const [registration, instance] of [...instances].reverse()) {
    const cleanup = async (run?: DeadlineRun): Promise<void> => {
      instance.run = run;
      // A fixture still stuck before use() has no published value to release.
      // Its original callback remains owned by the retiring process.
      if (instance.release) { instance.release.resolve(); await instance.completion; }
      if (instance.teardownFailure) throw instance.teardownFailure.error;
    };
    try {
      if (budget) {
        const slot = instance.slot ?? budget.slot;
        if (!exhausted(slot)) await withDeadline(slot, `Fixture "${registration.name}" teardown`, cleanup);
        else if (instance.teardownFailure) throw instance.teardownFailure.error;
      } else await cleanup();
    } catch (error) { errors.push(error); }
    finally { instance.run = undefined; instance.retired = true; instances.delete(registration); }
  }
  if (errors.length) throw new AggregateError(errors, 'Fixture teardown failed');
}

/** Owns fixture phases. Timed-out callbacks cannot publish late fixture values;
 * they remain in their original process, which must retire before replacement. */
export class FixtureWorker {
  readonly #pool: FixturePool;
  readonly #info: unknown;
  readonly #runWorkerFixture: WorkerFixtureContext;
  readonly #projectTimeout: number;
  readonly #instances: Instances = new Map();
  #attempt: FixtureAttempt | undefined;
  #closure: Promise<void> | undefined;
  constructor(pool: FixturePool, workerInfo: unknown, runWorkerFixture: WorkerFixtureContext = callback => callback(), projectTimeout = 30000) {
    pool.validate(); this.#pool = pool; this.#info = workerInfo; this.#runWorkerFixture = runWorkerFixture;
    this.#projectTimeout = projectTimeout;
  }
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
    const attempt = new FixtureAttempt(pool, info, this.#info, this.#instances, identities, this.#runWorkerFixture, () => { if (this.#attempt === attempt) this.#attempt = undefined; }, this.#projectTimeout);
    this.#attempt = attempt;
    return attempt;
  }
  validatePool(pool: FixturePool): void {
    pool.validate();
    if (!this.#pool.hasSameWorkerFixtures(pool)) throw new FixtureConfigurationError('Changed worker fixtures require a fresh worker');
  }
  close(budget?: PhaseBudget): Promise<void> {
    if (!this.#closure) this.#closure = this.finish(budget);
    return this.#closure;
  }
  private async finish(budget?: PhaseBudget): Promise<void> {
    const errors: unknown[] = [];
    try { await this.#attempt?.close(budget); } catch (error) { addErrors(errors, error); }
    try { await retire(this.#instances, budget); } catch (error) { addErrors(errors, error); }
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
  readonly #runWorkerFixture: WorkerFixtureContext;
  readonly #projectTimeout: number;
  #operation: Promise<unknown> | undefined;
  #closure: Promise<void> | undefined;
  constructor(pool: FixturePool, testInfo: unknown, workerInfo: unknown, workerInstances: Instances, workerIdentities: ReadonlyMap<FixtureRegistration, FixtureRegistration>, runWorkerFixture: WorkerFixtureContext, onClosed: () => void, projectTimeout = 30000) {
    this.#pool = pool; this.#testInfo = testInfo; this.#workerInfo = workerInfo;
    this.#workerInstances = workerInstances; this.#workerIdentities = workerIdentities; this.#onClosed = onClosed;
    this.#runWorkerFixture = runWorkerFixture;
    this.#projectTimeout = projectTimeout;
  }
  run<T>(callback: (values: FixtureValues, info: unknown) => T, automatic: AutomaticScope = 'test', budget?: PhaseBudget): Promise<FixtureRunResult<Awaited<T>>> {
    if (this.#closure) return Promise.reject(new FixtureConfigurationError('Test fixture scope is closing'));
    if (this.#operation) return Promise.reject(new FixtureConfigurationError('Concurrent fixture callbacks require separate test scopes'));
    const operation = Promise.resolve().then(() => this.invoke(callback, automatic, budget));
    this.#operation = operation;
    // Observe both outcomes without replacing the callback's rejection or
    // creating an unhandled finally-promise when the caller fails.
    void operation.then(() => { this.#operation = undefined; }, () => { this.#operation = undefined; });
    return operation;
  }
  close(budget?: PhaseBudget): Promise<void> {
    if (!this.#closure) this.#closure = this.finish(budget);
    return this.#closure;
  }
  private async finish(budget?: PhaseBudget): Promise<void> {
    try {
      // The caller retains the test/setup error. Cleanup waits for its exact
      // invocation, then reports only cleanup failures through this promise.
      await this.#operation?.catch(() => {});
      await retire(this.#testInstances, budget);
    } finally { this.#onClosed(); }
  }
  private identity(registration: FixtureRegistration): FixtureRegistration { return registration.scope === 'worker' ? this.#workerIdentities.get(registration)! : registration; }
  private instances(scope: FixtureScope): Instances { return scope === 'worker' ? this.#workerInstances : this.#testInstances; }
  private async invoke<T>(callback: (values: FixtureValues, info: unknown) => T, automatic: AutomaticScope, budget?: PhaseBudget): Promise<FixtureRunResult<Awaited<T>>> {
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
    for (const registration of ordered) await this.setup(registration, budget);
    const values: FixtureValues = Object.create(null) as FixtureValues;
    for (const registration of required) {
      const instance = this.instances(registration.scope).get(this.identity(registration))!;
      if (instance.failed) return { ran: false };
      values[registration.name] = instance.value;
    }
    const invoke = async (): Promise<Awaited<T>> => await callback(values, this.#testInfo);
    return { ran: true, value: budget ? await withDeadline(budget.slot, budget.phase, invoke) : await invoke() };
  }
  private async setup(registration: FixtureRegistration, budget?: PhaseBudget): Promise<void> {
    const instances = this.instances(registration.scope);
    if (instances.has(this.identity(registration))) return;
    const timeout = registration.timeout ?? (registration.scope === 'worker' ? this.#projectTimeout : undefined);
    const instance: Instance = { registration, value: registration.value, failed: false, release: undefined, completion: undefined, teardownFailure: undefined, slot: timeout === undefined ? undefined : timeSlot(timeout), run: undefined, setupFailure: undefined, acceptingUse: true, retired: false };
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
      if (!instance.acceptingUse || instance.retired || (budget && !instance.run?.active)) throw instance.setupFailure ?? new FixtureConfigurationError(`Fixture "${registration.name}" setup has ended`);
      if (used) throw new FixtureConfigurationError(`Fixture "${registration.name}" called use() more than once`);
      used = true; instance.value = value; instance.release = deferred<void>();
      available.resolve();
      await instance.release.promise;
    };
    const info = registration.scope === 'worker' ? this.#workerInfo : this.#testInfo;
    const run = async (): Promise<void> => {
      try {
        await (registration.value as FixtureFunction)(values, use, info);
        if (!used) throw new FixtureConfigurationError(`Fixture "${registration.name}" completed without use()`);
      } catch (error) {
        instance.failed = true;
        if (!used) available.reject(error);
        else instance.teardownFailure = { error };
      }
    };
    const setup = async (deadline?: DeadlineRun): Promise<void> => {
      instance.run = deadline;
      const execute = (): Promise<void> => inDeadlineContext(() => instance.run, run);
      instance.completion = registration.scope === 'worker' ? this.#runWorkerFixture(execute) : execute();
      await available.promise;
    };
    try {
      if (budget) await withDeadline(instance.slot ?? budget.slot, `Fixture "${registration.name}" setup`, setup);
      else await setup();
    } catch (error) { instance.failed = true; instance.setupFailure = error; throw error; }
    finally { instance.acceptingUse = false; instance.run = undefined; }
  }
}
