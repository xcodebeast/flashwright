// Internal candidate; not exported by the public runner entry point.
export type FixtureScope = 'test' | 'worker';
export type FixtureAuto = boolean | 'all-hooks-included';
export type FixtureValues = Record<string, unknown>;
export type FixtureFunction = (values: FixtureValues, use: (value?: unknown) => Promise<void>, info: unknown) => unknown;
export type FixtureCallback = (values: FixtureValues, info: unknown) => unknown;
export interface FixtureRegistration {
  readonly name: string;
  readonly value: unknown;
  readonly scope: FixtureScope;
  readonly auto: FixtureAuto;
  readonly option: boolean;
  readonly dependencies: readonly string[];
  readonly previous: FixtureRegistration | undefined;
  readonly configurationOverride: boolean;
}

export class FixtureConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = 'FixtureConfigurationError'; }
}

const signatures = new WeakMap<Function, readonly string[]>();

// Scan just the signature. Comments and nested destructuring must not change
// dependency order; unsupported binding syntax must never silently omit work.
function signatureText(source: string): string {
  let text = '', depth = 0, opened = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      text += ' '; continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new FixtureConfigurationError('Unterminated fixture signature comment');
      i = end + 1; text += ' '; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      throw new FixtureConfigurationError('Quoted, computed and default fixture bindings are not supported');
    }
    if (!opened && (ch === '=' || ch === '{')) throw new FixtureConfigurationError('First argument must use parenthesized object destructuring');
    if (ch === '(') { depth++; opened = true; }
    text += ch;
    if (ch === ')' && --depth === 0) return text;
  }
  throw new FixtureConfigurationError('Fixture callback has no supported parameter signature');
}
function commaParts(text: string): string[] {
  const parts: string[] = [], closers: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '{' || ch === '[' || ch === '(') closers.push(ch === '{' ? '}' : ch === '[' ? ']' : ')');
    else if ('}])'.includes(ch)) {
      if (closers.pop() !== ch) throw new FixtureConfigurationError('Unbalanced fixture signature');
    } else if (ch === ',' && !closers.length) { parts.push(text.slice(start, i).trim()); start = i + 1; }
  }
  if (closers.length) throw new FixtureConfigurationError('Unbalanced fixture signature');
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}
export function fixtureDependencies(fn: Function): readonly string[] {
  const cached = signatures.get(fn);
  if (cached) return cached;
  const source = Function.prototype.toString.call(fn);
  const signature = signatureText(source);
  const start = signature.indexOf('(');
  const prefix = signature.slice(0, start).trim();
  if (!/^(?:async\s*)?(?:function(?:\s+[$\w]+)?|[$\w]+)?$/.test(prefix)) throw new FixtureConfigurationError('Unsupported fixture callback signature');
  const first = commaParts(signature.slice(start + 1, -1))[0];
  if (first !== undefined && !(first.startsWith('{') && first.endsWith('}'))) throw new FixtureConfigurationError('First argument must use the object destructuring pattern');
  const names = first === undefined ? [] : commaParts(first.slice(1, -1)).map(binding => {
    const name = binding.split(':', 1)[0]!.trim();
    if (!/^[$A-Z_a-z][$\w]*$/.test(name) || binding.includes('=') || binding.includes('...')) throw new FixtureConfigurationError(`Unsupported fixture binding: ${binding}`);
    return name;
  });
  const result = Object.freeze(names);
  signatures.set(fn, result);
  return result;
}

interface PoolOptions { configurationUse?: FixtureValues }
interface UseOptions { inDescribe?: boolean }
export class FixturePool {
  readonly #registrations: Map<string, FixtureRegistration>;
  readonly #configurationUse: FixtureValues;
  #validated = false;
  constructor(definitions: FixtureValues = {}, options: PoolOptions = {}, parent?: FixturePool) {
    this.#registrations = new Map(parent ? parent.#registrations : undefined);
    this.#configurationUse = Object.freeze({ ...(parent ? parent.#configurationUse : options.configurationUse) });
    this.append(definitions, false, false);
    const selected: FixtureValues = Object.create(null) as FixtureValues;
    for (const [name, definition] of Object.entries(definitions)) {
      if (Array.isArray(definition) && definition[1]?.option === true && Object.hasOwn(this.#configurationUse, name)) {
        selected[name] = [this.#configurationUse[name], definition[1]];
      }
    }
    this.append(selected, true, false);
  }
  extend(definitions: FixtureValues): FixturePool { return new FixturePool(definitions, {}, this); }
  withUse(values: FixtureValues, options: UseOptions = {}): FixturePool {
    const pool = new FixturePool({}, {}, this);
    pool.append(values, false, options.inDescribe ?? false);
    return pool;
  }
  resolve(name: string, consumer?: FixtureRegistration): FixtureRegistration | undefined {
    return consumer?.name === name ? consumer.previous : this.#registrations.get(name);
  }
  registrations(): readonly FixtureRegistration[] { return [...this.#registrations.values()]; }
  required(fn: Function): readonly FixtureRegistration[] {
    this.validate();
    return fixtureDependencies(fn).map(name => {
      const registration = this.resolve(name);
      if (!registration) throw new FixtureConfigurationError(`Callback has unknown fixture "${name}"`);
      return registration;
    });
  }
  private append(definitions: FixtureValues, configurationOverride: boolean, inDescribe: boolean): void {
    for (const [name, definition] of Object.entries(definitions)) {
      const previous = this.#registrations.get(name);
      let value = definition;
      let scope: FixtureScope = previous?.scope ?? 'test';
      let auto: FixtureAuto = previous?.auto ?? false;
      let option = previous?.option ?? false;
      if (Array.isArray(definition) && typeof definition[1] === 'object') {
        const settings = definition[1] as Record<string, unknown> | null;
        if (!settings || definition.length !== 2) throw new FixtureConfigurationError(`Invalid fixture tuple for "${name}"`);
        for (const key of Object.keys(settings)) if (!['scope', 'auto', 'option'].includes(key)) throw new FixtureConfigurationError(`Fixture option "${key}" is not implemented by the independent fixture core`);
        const declaredScope = settings.scope ?? 'test', declaredAuto = settings.auto ?? false;
        if (declaredScope !== 'test' && declaredScope !== 'worker') throw new FixtureConfigurationError(`Unknown scope for fixture "${name}"`);
        if (![true, false, 'all-hooks-included'].includes(declaredAuto as FixtureAuto)) throw new FixtureConfigurationError(`Invalid automatic fixture "${name}"`);
        if (settings.option !== undefined && typeof settings.option !== 'boolean') throw new FixtureConfigurationError(`Invalid option declaration for "${name}"`);
        scope = declaredScope; auto = declaredAuto as FixtureAuto; option = settings.option === true;
        if (previous && (scope !== previous.scope || auto !== previous.auto)) throw new FixtureConfigurationError(`Override changes scope or auto policy of fixture "${name}"`);
        value = definition[0];
      }
      if (inDescribe && scope === 'worker') throw new FixtureConfigurationError(`Worker fixture "${name}" cannot be overridden inside describe`);
      if (value === undefined && option && previous) {
        let original = previous;
        while (!original.configurationOverride && original.previous) original = original.previous;
        value = original.value;
      }
      const dependencies = typeof value === 'function' ? fixtureDependencies(value) : Object.freeze([] as string[]);
      this.#registrations.set(name, Object.freeze({ name, value, scope, auto, option, dependencies, previous, configurationOverride }));
    }
  }
  validate(): void {
    if (this.#validated) return;
    for (const name of Object.keys(this.#configurationUse)) {
      const registration = this.#registrations.get(name);
      if (registration && !registration.option) throw new FixtureConfigurationError(`Configuration use cannot override non-option fixture "${name}"`);
    }
    const visited = new Set<FixtureRegistration>(), visiting = new Set<FixtureRegistration>();
    const visit = (registration: FixtureRegistration): void => {
      if (visiting.has(registration)) throw new FixtureConfigurationError(`Dependency cycle at fixture "${registration.name}"`);
      if (visited.has(registration)) return;
      visiting.add(registration);
      for (const name of registration.dependencies) {
        const dependency = this.resolve(name, registration);
        if (!dependency) throw new FixtureConfigurationError(`Fixture "${registration.name}" has unknown dependency "${name}" or no base implementation`);
        if (registration.scope === 'worker' && dependency.scope === 'test') throw new FixtureConfigurationError(`Worker fixture "${registration.name}" cannot depend on test fixture "${name}"`);
        visit(dependency);
      }
      visiting.delete(registration); visited.add(registration);
    };
    for (const registration of this.#registrations.values()) visit(registration);
    this.#validated = true;
  }
}
