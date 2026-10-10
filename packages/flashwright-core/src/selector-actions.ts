import { failure } from './errors.js';
import { validateBoolean, validateOptions } from './validation.js';
import { prepareTyping } from './keyboard.js';
import type { ClickOptions, FillOptions, LocatorTimeoutOptions, PressOptions, SelectOption } from './locator.js';

export interface SelectorStrictOptions { strict?: boolean }
export type SelectorOptions<Options> = Options & SelectorStrictOptions;
export type ActionExecutor = <Result>(action: string, parameters: object, options: LocatorTimeoutOptions) => Promise<Result>;

/** Shared argument validation and native dispatch for strict locators and selector actions. */
export class SelectorActions {
  constructor(private readonly run: ActionExecutor, private readonly publicOwner = 'locator') {}
  async pointer(action: string, options: ClickOptions, checked?: boolean): Promise<void> {
    const supported = ['force', 'trial', 'position', 'timeout'];
    if (action === 'click' || action === 'dblclick') supported.push('button', 'delay', 'modifiers', 'noWaitAfter');
    if (action === 'click') supported.push('clickCount');
    if (action === 'hover') supported.push('modifiers');
    if (checked !== undefined) supported.push('noWaitAfter');
    const method = `${this.publicOwner}.${action}`;
    validateOptions(method, options, supported);
    for (const name of ['force', 'trial', 'noWaitAfter'] as const) validateBoolean(`${method}.${name}`, options[name]);
    if (options.button !== undefined && !['left', 'right', 'middle'].includes(options.button)) throw failure('InvalidArgumentError', method, 'invalid mouse button');
    if (options.clickCount !== undefined && (!Number.isInteger(options.clickCount) || options.clickCount < 1 || options.clickCount > 100)) throw failure('InvalidArgumentError', method, 'clickCount must be an integer from 1 to 100');
    if (options.delay !== undefined && (!Number.isFinite(options.delay) || options.delay < 0)) throw failure('InvalidArgumentError', method, 'delay must be a finite nonnegative number');
    if (options.position !== undefined) {
      validateOptions(`${method}.position`, options.position, ['x', 'y']);
      if (![options.position.x, options.position.y].every(Number.isFinite)) throw failure('InvalidArgumentError', method, 'position coordinates must be finite numbers');
    }
    if (options.modifiers !== undefined && (!Array.isArray(options.modifiers) || options.modifiers.some(modifier => !['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'].includes(modifier)))) throw failure('InvalidArgumentError', method, 'invalid keyboard modifier');
    const { timeout, ...pointer } = options;
    return this.run(action, { ...pointer, ...(checked === undefined ? {} : { checked }) }, timeout === undefined ? {} : { timeout });
  }
  async press(key: string, options: PressOptions = {}): Promise<void> {
    validateOptions(`${this.publicOwner}.press`, options, ['timeout', 'delay', 'noWaitAfter']);
    validateBoolean(`${this.publicOwner}.press.noWaitAfter`, options.noWaitAfter);
    if (typeof key !== 'string') throw failure('InvalidArgumentError', `${this.publicOwner}.press`, 'key must be a string');
    if (options.delay !== undefined && (!Number.isFinite(options.delay) || options.delay < 0)) throw failure('InvalidArgumentError', `${this.publicOwner}.press`, 'delay must be a finite nonnegative number');
    const { timeout, ...keyboard } = options;
    return this.run('press', { ...keyboard, keyUnits: Array.from({ length: key.length }, (_, index) => key.charCodeAt(index)) }, timeout === undefined ? {} : { timeout });
  }
  /** Focus once and let the browser route the remaining characters as application focus changes. */
  async pressSequentially(text: string, options: PressOptions = {}, publicMethod = 'pressSequentially'): Promise<void> {
    const method = `${this.publicOwner}.${publicMethod}`;
    validateOptions(method, options, ['timeout', 'delay', 'noWaitAfter']);
    validateBoolean(`${method}.noWaitAfter`, options.noWaitAfter);
    return this.run('pressSequentially', prepareTyping(text, options, method), options.timeout === undefined ? {} : { timeout: options.timeout });
  }
  async focus(options: LocatorTimeoutOptions = {}): Promise<void> {
    validateOptions(`${this.publicOwner}.focus`, options, ['timeout']);
    return this.run('focus', {}, options);
  }
  async fill(value: string, options: FillOptions = {}): Promise<void> {
    if (typeof value !== 'string') throw failure('InvalidArgumentError', `${this.publicOwner}.fill`, 'value must be a string');
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw failure('UnsupportedFeatureError', `${this.publicOwner}.fill`, 'native text input containing unpaired UTF-16 surrogates is not implemented');
    validateOptions(`${this.publicOwner}.fill`, options, ['force', 'noWaitAfter', 'timeout']);
    const { force = false, noWaitAfter, ...timeout } = options;
    validateBoolean(`${this.publicOwner}.fill.force`, force);
    validateBoolean(`${this.publicOwner}.fill.noWaitAfter`, noWaitAfter);
    return this.run('fill', { value, force }, timeout);
  }
  async selectOption(values: string | SelectOption | readonly string[] | readonly SelectOption[] | null, options: FillOptions = {}): Promise<string[]> {
    validateOptions(`${this.publicOwner}.selectOption`, options, ['force', 'noWaitAfter', 'timeout']);
    const { force = false, noWaitAfter, ...timeout } = options;
    const normalized = values === null ? [] : Array.isArray(values) ? values : [values];
    validateBoolean(`${this.publicOwner}.selectOption.force`, force);
    validateBoolean(`${this.publicOwner}.selectOption.noWaitAfter`, noWaitAfter);
    if (normalized.some(value => typeof value !== typeof normalized[0])) throw failure('InvalidArgumentError', `${this.publicOwner}.selectOption`, 'option arrays must contain only strings or only option objects');
    for (const value of normalized) {
      if (typeof value === 'string') continue;
      validateOptions(`${this.publicOwner}.selectOption`, value, ['value', 'label', 'index']);
      for (const name of ['value', 'label'] as const) if (value[name] !== undefined && typeof value[name] !== 'string') throw failure('InvalidArgumentError', `${this.publicOwner}.selectOption.${name}`, 'expected a string');
      if (value.index !== undefined && !Number.isInteger(value.index)) throw failure('InvalidArgumentError', `${this.publicOwner}.selectOption.index`, 'expected an integer');
    }
    return this.run('selectOption', { values: normalized.map(value => typeof value === 'string' ? { valueOrLabel: value } : value), force }, timeout);
  }
}

/** Public page/frame calls share trace schemas while retaining their public API names. */
export const selectorActionTraceMethods = {
  click: { className: 'Frame', parameters: ['selector', 'options'] },
  dblclick: { className: 'Frame', parameters: ['selector', 'options'] },
  hover: { className: 'Frame', parameters: ['selector', 'options'] },
  check: { className: 'Frame', parameters: ['selector', 'options'] },
  uncheck: { className: 'Frame', parameters: ['selector', 'options'] },
  setChecked: { className: 'Frame', method: (arguments_: readonly unknown[]) => arguments_[1] ? 'check' : 'uncheck', parameters: ['selector', 'checked', 'options'] },
  fill: { className: 'Frame', parameters: ['selector', 'value', 'options'] },
  focus: { className: 'Frame', parameters: ['selector', 'options'] },
  selectOption: { className: 'Frame', parameters: ['selector', 'values', 'options'] },
  press: { className: 'Frame', parameters: ['selector', 'key', 'options'] },
  type: { className: 'Frame', parameters: ['selector', 'text', 'options'] },
} as const;
