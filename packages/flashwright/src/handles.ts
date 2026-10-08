import type { EngineClient } from './client.js';
import type { Page } from './index.js';
import { failure, fromRecord } from './errors.js';
import { createValueCodec } from './serialization.cjs';

export type Unboxed<Value> = Value extends JSHandle<infer Handled> ? Handled
  : Value extends Date | RegExp | Function ? Value
  : Value extends object ? { [Key in keyof Value]: Unboxed<Value[Key]> } : Value;
export type SmartHandle<Value> = Value extends Node ? ElementHandle<Value> : JSHandle<Value>;
interface HandleInitialization { identifier: string; primitive: unknown; previewUnits: number[] | null; element: boolean; frame: string; nameUnits?: number[] }
interface HandleState { owner: Page; client: EngineClient; pageIdentifier: string; identifier: string; preview: string; disposed: boolean; disposing?: Promise<void> }
const states = new WeakMap<object, HandleState>();
const codec = createValueCodec();

/** Values are unboxed only after validating the actual owned handle, including nested arguments. */
export function encodeEvaluationArgument(argument: unknown, client: EngineClient, method: string): { argument: unknown; handles: { page: string; identifier: string }[] } {
  const handles: { page: string; identifier: string }[] = [];
  const indices = new Map<object, number>();
  let ownedFailure: Error | undefined;
  try {
    const encoded = codec.encode(argument, value => {
      if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
      const state = states.get(value);
      if (!state) return undefined;
      if (state.disposed || state.owner.isClosed()) ownedFailure = failure('TargetClosedError', method, 'JSHandle has been disposed or its page has closed');
      else if (state.client !== client) ownedFailure = failure('InvalidArgumentError', method, 'JSHandle belongs to another engine');
      if (ownedFailure) throw ownedFailure;
      let index = indices.get(value);
      if (index === undefined) { index = handles.length; indices.set(value, index); handles.push({ page: state.pageIdentifier, identifier: state.identifier }); }
      return index;
    });
    return { argument: encoded, handles };
  } catch (error) {
    if (error === ownedFailure) throw error;
    const details = codec.describeError(error);
    throw fromRecord({ code: details.code, method: `${method}.argument`, message: '', messageUtf16: details.messageUnits,
      diagnostics: { stage: 'argumentSerialization', messageTruncated: details.messageTruncated }, referenceVersion: '1.60.0', browser: 'chromium' });
  }
}

export function receivedHandles(owner: Page, client: EngineClient, pageIdentifier: string, result: unknown, previews?: string[]): { handle: JSHandle; name: string | undefined }[] {
  if (!result || typeof result !== 'object' || !('handles' in result) || !Array.isArray(result.handles)) throw failure('ProtocolError', 'handle', 'driver omitted handle initializations');
  return result.handles.map((initialization: HandleInitialization, index: number) => {
    if (typeof initialization.identifier !== 'string' || typeof initialization.element !== 'boolean') throw failure('ProtocolError', 'handle', 'driver omitted handle identity or type');
    const preview = previews?.[index] ?? (initialization.primitive !== null ? String(codec.decode(initialization.primitive))
      : initialization.previewUnits ? codec.decode({ kind: 'string', units: initialization.previewUnits }) as string : 'JSHandle@object');
    const state: HandleState = { owner, client, pageIdentifier, identifier: initialization.identifier, preview, disposed: false };
    const handle = initialization.element ? new ElementHandle(state) : new JSHandle(state);
    return { handle, name: initialization.nameUnits ? codec.decode({ kind: 'string', units: initialization.nameUnits }) as string : undefined };
  });
}

/** A JSHandle always evaluates in the execution context that originally created it. */
export class JSHandle<Value = any> {
  constructor(state: HandleState) { states.set(this, state); }
  private state(method: string): HandleState {
    const state = states.get(this);
    if (!state) throw failure('InvalidArgumentError', method, 'expected an owned JSHandle');
    if (state.disposed || state.owner.isClosed()) throw failure('TargetClosedError', method, 'JSHandle has been disposed or its page has closed');
    return state;
  }
  async evaluate<Result, Argument>(pageFunction: string | ((value: Value, argument: Unboxed<Argument>) => Result | Promise<Result>), argument: Argument): Promise<Result>;
  async evaluate<Result>(pageFunction: string | ((value: Value) => Result | Promise<Result>)): Promise<Result>;
  async evaluate(pageFunction: string | Function, argument?: unknown): Promise<unknown> {
    const state = this.state('handle.evaluate');
    return state.owner.runEvaluation('handle.evaluate', pageFunction, argument, { handle: state.identifier });
  }
  async evaluateHandle<Result, Argument>(pageFunction: string | ((value: Value, argument: Unboxed<Argument>) => Result | Promise<Result>), argument: Argument): Promise<SmartHandle<Result>>;
  async evaluateHandle<Result>(pageFunction: string | ((value: Value) => Result | Promise<Result>)): Promise<SmartHandle<Result>>;
  async evaluateHandle(pageFunction: string | Function, argument?: unknown): Promise<JSHandle> {
    const state = this.state('handle.evaluateHandle');
    return state.owner.runEvaluation('handle.evaluateHandle', pageFunction, argument, { handle: state.identifier }) as Promise<JSHandle>;
  }
  async jsonValue(): Promise<Value> {
    const state = this.state('handle.jsonValue');
    return codec.decode(await state.owner.runHandle('handle.jsonValue', state.identifier)) as Value;
  }
  async getProperty<Key extends keyof Value & string>(propertyName: Key): Promise<SmartHandle<Value[Key]>>;
  async getProperty(propertyName: string): Promise<JSHandle>;
  async getProperty(propertyName: string): Promise<JSHandle> {
    const state = this.state('handle.getProperty');
    if (typeof propertyName !== 'string') throw failure('InvalidArgumentError', 'handle.getProperty', 'property name must be a string');
    if (propertyName.length > 100000) throw failure('ResourceLimitError', 'handle.getProperty', 'property name exceeds 100000 UTF-16 units');
    const result = await state.owner.runHandle('handle.getProperty', state.identifier, { name: Array.from({ length: propertyName.length }, (_, index) => propertyName.charCodeAt(index)) });
    return receivedHandles(state.owner, state.client, state.pageIdentifier, result)[0]!.handle;
  }
  async getProperties(): Promise<Map<string, JSHandle>> {
    const state = this.state('handle.getProperties');
    const result = await state.owner.runHandle('handle.getProperties', state.identifier);
    return new Map(receivedHandles(state.owner, state.client, state.pageIdentifier, result).map(({ name, handle }) => {
      if (name === undefined) throw failure('ProtocolError', 'handle.getProperties', 'driver omitted property name');
      return [name, handle];
    }));
  }
  asElement(): Value extends Node ? ElementHandle<Value> : null {
    return (this instanceof ElementHandle ? this : null) as Value extends Node ? ElementHandle<Value> : null;
  }
  toString(): string { return states.get(this)?.preview ?? 'JSHandle'; }
  dispose(): Promise<void> {
    const state = states.get(this);
    if (!state || state.disposed) return state?.disposing ?? Promise.resolve();
    state.disposed = true;
    state.disposing = (async () => {
      if (state.owner.isClosed()) return;
      try { await state.owner.runHandle('handle.dispose', state.identifier); }
      catch (error) { if (!state.owner.isClosed()) throw error; }
    })();
    return state.disposing;
  }
  async [Symbol.asyncDispose](): Promise<void> { await this.dispose(); }
}

export class ElementHandle<Value extends Node = HTMLElement> extends JSHandle<Value> {
  private unsupported(method: string): Promise<never> { return Promise.reject(failure('UnsupportedFeatureError', `elementHandle.${method}`, 'this ElementHandle operation is not implemented; use a Locator for supported actions and reads')); }
  click(..._arguments: unknown[]): Promise<never> { return this.unsupported('click'); }
  dblclick(..._arguments: unknown[]): Promise<never> { return this.unsupported('dblclick'); }
  hover(..._arguments: unknown[]): Promise<never> { return this.unsupported('hover'); }
  fill(..._arguments: unknown[]): Promise<never> { return this.unsupported('fill'); }
  check(..._arguments: unknown[]): Promise<never> { return this.unsupported('check'); }
  uncheck(..._arguments: unknown[]): Promise<never> { return this.unsupported('uncheck'); }
  setChecked(..._arguments: unknown[]): Promise<never> { return this.unsupported('setChecked'); }
  press(..._arguments: unknown[]): Promise<never> { return this.unsupported('press'); }
  focus(..._arguments: unknown[]): Promise<never> { return this.unsupported('focus'); }
  getAttribute(..._arguments: unknown[]): Promise<never> { return this.unsupported('getAttribute'); }
  textContent(..._arguments: unknown[]): Promise<never> { return this.unsupported('textContent'); }
  innerText(..._arguments: unknown[]): Promise<never> { return this.unsupported('innerText'); }
  innerHTML(..._arguments: unknown[]): Promise<never> { return this.unsupported('innerHTML'); }
  inputValue(..._arguments: unknown[]): Promise<never> { return this.unsupported('inputValue'); }
  boundingBox(..._arguments: unknown[]): Promise<never> { return this.unsupported('boundingBox'); }
  screenshot(..._arguments: unknown[]): Promise<never> { return this.unsupported('screenshot'); }
  ownerFrame(..._arguments: unknown[]): Promise<never> { return this.unsupported('ownerFrame'); }
  contentFrame(..._arguments: unknown[]): Promise<never> { return this.unsupported('contentFrame'); }
  waitForElementState(..._arguments: unknown[]): Promise<never> { return this.unsupported('waitForElementState'); }
  waitForSelector(..._arguments: unknown[]): Promise<never> { return this.unsupported('waitForSelector'); }
  selectOption(..._arguments: unknown[]): Promise<never> { return this.unsupported('selectOption'); }
  setInputFiles(..._arguments: unknown[]): Promise<never> { return this.unsupported('setInputFiles'); }
  dispatchEvent(..._arguments: unknown[]): Promise<never> { return this.unsupported('dispatchEvent'); }
  scrollIntoViewIfNeeded(..._arguments: unknown[]): Promise<never> { return this.unsupported('scrollIntoViewIfNeeded'); }
  isVisible(..._arguments: unknown[]): Promise<never> { return this.unsupported('isVisible'); }
  isHidden(..._arguments: unknown[]): Promise<never> { return this.unsupported('isHidden'); }
  isChecked(..._arguments: unknown[]): Promise<never> { return this.unsupported('isChecked'); }
  isDisabled(..._arguments: unknown[]): Promise<never> { return this.unsupported('isDisabled'); }
  isEditable(..._arguments: unknown[]): Promise<never> { return this.unsupported('isEditable'); }
  isEnabled(..._arguments: unknown[]): Promise<never> { return this.unsupported('isEnabled'); }
  tap(..._arguments: unknown[]): Promise<never> { return this.unsupported('tap'); }
  type(..._arguments: unknown[]): Promise<never> { return this.unsupported('type'); }
  $(..._arguments: unknown[]): Promise<never> { return this.unsupported('$'); }
  $$(..._arguments: unknown[]): Promise<never> { return this.unsupported('$$'); }
  $eval(..._arguments: unknown[]): Promise<never> { return this.unsupported('$eval'); }
  $$eval(..._arguments: unknown[]): Promise<never> { return this.unsupported('$$eval'); }
}
