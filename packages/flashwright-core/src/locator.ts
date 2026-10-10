import { instrumentTraceMethods, tracePageOwner } from './trace-hooks.js';
import type { AssertionOptions, AssertionResult } from './assertions.js';
import type { Frame } from './frame.js';
import type { Page } from './index.js';
import { failure } from './errors.js';
import { validateBoolean, validateOptions } from './validation.js';
import type { ElementHandle, JSHandle, SmartHandle, Unboxed } from './handles.js';
import { SelectorActions } from './selector-actions.js';
import type { InputFiles, SetInputFilesOptions } from './file-inputs.js';

export interface LocatorOptions { has?: Locator; hasNot?: Locator; hasText?: string | RegExp; hasNotText?: string | RegExp; visible?: boolean }
export interface TextOptions { exact?: boolean }
export interface RoleOptions extends TextOptions { name?: string | RegExp; description?: string | RegExp; checked?: boolean; disabled?: boolean; selected?: boolean; expanded?: boolean; includeHidden?: boolean; level?: number; pressed?: boolean }
export interface LocatorTimeoutOptions { timeout?: number }
export interface FillOptions extends LocatorTimeoutOptions { force?: boolean; noWaitAfter?: boolean }
export interface SelectTextOptions extends LocatorTimeoutOptions { force?: boolean }
export interface SelectOption { value?: string; label?: string; index?: number }
export type KeyboardModifier = 'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift';
export interface HoverOptions extends LocatorTimeoutOptions { force?: boolean; trial?: boolean; position?: { x: number; y: number }; modifiers?: KeyboardModifier[] }
export interface ClickOptions extends HoverOptions { button?: 'left' | 'right' | 'middle'; clickCount?: number; delay?: number; noWaitAfter?: boolean }
export interface PressOptions extends LocatorTimeoutOptions { delay?: number; noWaitAfter?: boolean }
export interface CheckOptions extends Omit<HoverOptions, 'modifiers'> { noWaitAfter?: boolean }
type TextMatcher = string | RegExp;

function exactOption(method: string, options: TextOptions): boolean {
  validateOptions(method, options, ['exact']);
  validateBoolean(`${method}.exact`, options.exact);
  return options.exact ?? false;
}

function validateText(value: unknown): asserts value is TextMatcher {
  if (typeof value !== 'string' && !(value instanceof RegExp)) throw failure('InvalidArgumentError', 'locator', 'text must be a string or regular expression');
}

/** String escaping follows the pinned Playwright isomorphic/stringUtils.ts contract. */
function escapeRegularExpression(value: RegExp): string {
  if (value.unicode || value.flags.includes('v')) return String(value);
  return String(value).replace(/(^|[^\\])(\\\\)*(["'`])/g, '$1$2\\$3').replace(/>>/g, '\\>\\>');
}
function textSelector(value: TextMatcher, exact = false): string {
  validateText(value);
  return typeof value === 'string' ? `${JSON.stringify(value)}${exact ? 's' : 'i'}` : escapeRegularExpression(value);
}
function attributeSelector(value: TextMatcher, exact = false): string {
  validateText(value);
  return typeof value === 'string' ? `"${value.replace(/\\/g, '\\\\').replace(/[\"]/g, '\\"')}"${exact ? 's' : 'i'}` : escapeRegularExpression(value);
}

/** Shared locator construction for Page, Frame and existing locator scopes. */
export class LocatorScope {
  constructor(private readonly scopeFrame: () => Frame, private readonly prefix = '') {}
  locator(selector: string | Locator, locatorOptions: LocatorOptions = {}): Locator {
    const frame = this.scopeFrame();
    let query: string;
    if (typeof selector === 'string') query = selector;
    else { sameFrame(frame, selector); query = `internal:chain=${JSON.stringify(selector.selector)}`; }
    return new Locator(frame, this.prefix ? `${this.prefix} >> ${query}` : query, locatorOptions);
  }
  frameLocator(selector: string): FrameLocator {
    validateFrameSelector(selector);
    return new FrameLocator(this.scopeFrame(), this.prefix ? `${this.prefix} >> ${selector}` : selector);
  }
  getByText(text: TextMatcher, options: TextOptions = {}): Locator { return this.locator(`internal:text=${textSelector(text, exactOption('getByText', options))}`); }
  getByLabel(text: TextMatcher, options: TextOptions = {}): Locator { return this.locator(`internal:label=${textSelector(text, exactOption('getByLabel', options))}`); }
  getByTestId(testId: TextMatcher): Locator { return this.locator(`internal:testid=[data-testid=${attributeSelector(testId, true)}]`); }
  getByPlaceholder(text: TextMatcher, options: TextOptions = {}): Locator { return this.locator(`internal:attr=[placeholder=${attributeSelector(text, exactOption('getByPlaceholder', options))}]`); }
  getByAltText(text: TextMatcher, options: TextOptions = {}): Locator { return this.locator(`internal:attr=[alt=${attributeSelector(text, exactOption('getByAltText', options))}]`); }
  getByTitle(text: TextMatcher, options: TextOptions = {}): Locator { return this.locator(`internal:attr=[title=${attributeSelector(text, exactOption('getByTitle', options))}]`); }
  getByRole(role: string, options: RoleOptions = {}): Locator {
    validateOptions('getByRole', options, ['exact', 'name', 'description', 'checked', 'disabled', 'selected', 'expanded', 'includeHidden', 'level', 'pressed']);
    for (const name of ['exact', 'checked', 'disabled', 'selected', 'expanded', 'includeHidden', 'pressed'] as const) validateBoolean(`getByRole.${name}`, options[name]);
    if (options.level !== undefined && !Number.isInteger(options.level)) throw failure('InvalidArgumentError', 'getByRole.level', 'expected an integer');
    const properties: string[] = [];
    for (const [name, value] of Object.entries(options)) {
      if (name === 'exact' || value === undefined) continue;
      if (!['name', 'description', 'checked', 'disabled', 'selected', 'expanded', 'includeHidden', 'level', 'pressed'].includes(name)) throw failure('UnsupportedFeatureError', `getByRole.${name}`, 'option is not implemented');
      const encoded = name === 'name' || name === 'description' ? attributeSelector(value as TextMatcher, options.exact) : String(value);
      properties.push(`[${name === 'includeHidden' ? 'include-hidden' : name}=${encoded}]`);
    }
    return this.locator(`internal:role=${role}${properties.join('')}`);
  }
}

function sameFrame(frame: Frame, locator: Locator): void {
  if (!(locator instanceof Locator) || locator.ownerFrame !== frame) throw failure('InvalidArgumentError', 'locator', 'locators must belong to the same frame');
}

function validateFrameSelector(selector: unknown): asserts selector is string {
  if (typeof selector !== 'string') throw failure('InvalidArgumentError', 'frameLocator', 'selector must be a string');
}

/** Frame paths remain rooted in their original frame and resolve only when a locator runs. */
export class FrameLocator extends LocatorScope {
  constructor(private readonly ownerFrame: Frame, private readonly frameSelector: string) {
    validateFrameSelector(frameSelector);
    super(() => ownerFrame);
  }
  override locator(selector: string | Locator, options: LocatorOptions = {}): Locator {
    if (typeof selector !== 'string') sameFrame(this.ownerFrame, selector);
    // The pinned frame facade concatenates locator descriptors directly, without internal:chain.
    const query = typeof selector === 'string' ? selector : selector.selector;
    return new Locator(this.ownerFrame, `${this.frameSelector} >> internal:control=enter-frame >> ${query}`, options);
  }
  owner(): Locator { return new Locator(this.ownerFrame, this.frameSelector); }
  override frameLocator(selector: string): FrameLocator {
    validateFrameSelector(selector);
    return new FrameLocator(this.ownerFrame, `${this.frameSelector} >> internal:control=enter-frame >> ${selector}`);
  }
  first(): FrameLocator { return this.nth(0); }
  last(): FrameLocator { return this.nth(-1); }
  nth(index: number): FrameLocator { return new FrameLocator(this.ownerFrame, `${this.frameSelector} >> nth=${index}`); }
}

/** A locator stores a query, never the element found by an earlier operation. */
export class Locator extends LocatorScope {
  static {
    instrumentTraceMethods(this.prototype, 'Frame', locator => {
      const owner = tracePageOwner(locator.page());
      return owner ? { ...owner, selector: locator.selector } : undefined;
    }, {
        runAssertion: { method: 'expect', apiName: 'locator._expect', parameters: ['options', 'timeout'] },
        elementHandle: { method: 'waitForSelector', parameters: ['options'] },
        evaluate: { method: 'evaluateExpression', parameters: ['expression', 'arg', 'options'] },
        evaluateHandle: { method: 'evaluateExpressionHandle', parameters: ['expression', 'arg'] },
        pressSequentially: { method: 'type', parameters: ['text', 'options'] },
        selectText: { parameters: ['options'] },
        scrollIntoViewIfNeeded: { parameters: ['options'] }, setInputFiles: { parameters: ['files', 'options'] },
        press: { parameters: ['key', 'options'] },
        click: { parameters: ['options'] },
        dblclick: { parameters: ['options'] },
        hover: { parameters: ['options'] },
        check: { parameters: ['options'] },
        uncheck: { parameters: ['options'] },
        setChecked: { method: arguments_ => arguments_[0] ? 'check' : 'uncheck', parameters: ['checked', 'options'] },
        count: {},
        all: {},
        allTextContents: {},
        allInnerTexts: {},
        textContent: { parameters: ['options'] },
        innerText: { parameters: ['options'] },
        innerHTML: { parameters: ['options'] },
        getAttribute: { parameters: ['name', 'options'] },
        inputValue: { parameters: ['options'] },
        isVisible: { parameters: ['options'] },
        isHidden: { parameters: ['options'] },
        isEnabled: { parameters: ['options'] },
        isDisabled: { parameters: ['options'] },
        isEditable: { parameters: ['options'] },
        isChecked: { parameters: ['options'] },
        waitFor: { parameters: ['options'] },
        fill: { parameters: ['value', 'options'] },
        clear: { parameters: ['options'] },
        focus: { parameters: ['options'] },
        blur: { parameters: ['options'] },
        selectOption: { parameters: ['values', 'options'] },
    }, 'Locator');
  }

  private readonly actions = new SelectorActions((action, parameters, options) => this.run(action, parameters, options));
  readonly selector: string;
  constructor(readonly ownerFrame: Frame, selector: string, options: LocatorOptions = {}) {
    validateOptions('locator', options, ['has', 'hasNot', 'hasText', 'hasNotText', 'visible']);
    validateBoolean('locator.visible', options.visible);
    let query = selector;
    for (const [name, value] of Object.entries(options)) {
      if (value === undefined) continue;
      if (name === 'hasText' || name === 'hasNotText') query += ` >> internal:${name === 'hasText' ? 'has-text' : 'has-not-text'}=${textSelector(value as TextMatcher)}`;
      else if (name === 'has' || name === 'hasNot') {
        sameFrame(ownerFrame, value as Locator);
        query += ` >> internal:${name === 'has' ? 'has' : 'has-not'}=${JSON.stringify((value as Locator).selector)}`;
      } else if (name === 'visible') query += ` >> visible=${value ? 'true' : 'false'}`;
      else throw failure('UnsupportedFeatureError', `locator.${name}`, 'option is not implemented');
    }
    super(() => ownerFrame, query);
    this.selector = query;
  }
  page(): Page { return this.ownerFrame.page(); }
  contentFrame(): FrameLocator { return new FrameLocator(this.ownerFrame, this.selector); }
  runAssertion(options: AssertionOptions, timeout: number): Promise<AssertionResult> { return this.ownerFrame.runAssertion(this.selector, options, timeout); }
  filter(options: LocatorOptions): Locator { return new Locator(this.ownerFrame, this.selector, options); }
  nth(index: number): Locator { return new Locator(this.ownerFrame, `${this.selector} >> nth=${index}`); }
  first(): Locator { return this.nth(0); }
  last(): Locator { return this.nth(-1); }
  and(locator: Locator): Locator { sameFrame(this.ownerFrame, locator); return new Locator(this.ownerFrame, `${this.selector} >> internal:and=${JSON.stringify(locator.selector)}`); }
  or(locator: Locator): Locator { sameFrame(this.ownerFrame, locator); return new Locator(this.ownerFrame, `${this.selector} >> internal:or=${JSON.stringify(locator.selector)}`); }
  toString(): string { return `locator(${JSON.stringify(this.selector)})`; }
  async setInputFiles(files: InputFiles, options: SetInputFilesOptions = {}): Promise<void> {
    validateOptions('locator.setInputFiles', options, ['timeout', 'noWaitAfter']);
    return this.ownerFrame.setInputFiles(this.selector, files, { ...options, strict: true });
  }
  private run<Result>(action: string, parameters: object = {}, options: LocatorTimeoutOptions = {}): Promise<Result> {
    return this.ownerFrame.runLocator(this.selector, action, parameters, options);
  }
  async elementHandle(options: LocatorTimeoutOptions = {}): Promise<ElementHandle<SVGElement | HTMLElement> | null> {
    validateOptions('locator.elementHandle', options, ['timeout']);
    return this.ownerFrame.waitForSelector(this.selector, { ...options, strict: true, state: 'attached' });
  }
  /** Resolution alone consumes the locator timeout; caller code is never retried or timed out here. */
  private async withElement<Result>(task: (element: ElementHandle<SVGElement | HTMLElement>) => Promise<Result>, options: LocatorTimeoutOptions): Promise<Result> {
    const element = await this.elementHandle(options);
    if (!element) throw failure('ProtocolError', 'locator', 'attached resolution returned no element');
    try { return await task(element); }
    finally { await element.dispose(); }
  }
  async evaluate<Result, Argument, Element extends SVGElement | HTMLElement = SVGElement | HTMLElement>(pageFunction: string | ((element: Element, argument: Unboxed<Argument>) => Result | Promise<Result>), argument: Argument, options?: LocatorTimeoutOptions): Promise<Result>;
  async evaluate<Result, Element extends SVGElement | HTMLElement = SVGElement | HTMLElement>(pageFunction: string | ((element: Element) => Result | Promise<Result>), options?: LocatorTimeoutOptions): Promise<Result>;
  async evaluate(pageFunction: Parameters<JSHandle['evaluate']>[0], argument?: unknown, options: LocatorTimeoutOptions = {}): Promise<unknown> {
    validateOptions('locator.evaluate', options, ['timeout']);
    if (typeof pageFunction !== 'string' && typeof pageFunction !== 'function') throw failure('InvalidArgumentError', 'locator.evaluate', 'expected a function or JavaScript expression string');
    return this.withElement(element => element.evaluate(pageFunction, argument), options);
  }
  async evaluateHandle<Result, Argument, Element extends SVGElement | HTMLElement = SVGElement | HTMLElement>(pageFunction: string | ((element: Element, argument: Unboxed<Argument>) => Result | Promise<Result>), argument: Argument): Promise<SmartHandle<Result>>;
  async evaluateHandle<Result, Element extends SVGElement | HTMLElement = SVGElement | HTMLElement>(pageFunction: string | ((element: Element) => Result | Promise<Result>)): Promise<SmartHandle<Result>>;
  async evaluateHandle(pageFunction: Parameters<JSHandle['evaluateHandle']>[0], argument?: unknown, options: LocatorTimeoutOptions = {}): Promise<JSHandle> {
    validateOptions('locator.evaluateHandle', options, ['timeout']);
    if (typeof pageFunction !== 'string' && typeof pageFunction !== 'function') throw failure('InvalidArgumentError', 'locator.evaluateHandle', 'expected a function or JavaScript expression string');
    return this.withElement(element => element.evaluateHandle(pageFunction, argument), options);
  }
  private pointer(action: string, options: ClickOptions, checked?: boolean): Promise<void> { return this.actions.pointer(action, options, checked); }
  press(key: string, options: PressOptions = {}): Promise<void> { return this.actions.press(key, options); }
  pressSequentially(text: string, options: PressOptions = {}): Promise<void> { return this.actions.pressSequentially(text, options); }
  /** Native capture owns resolution and selection under one deadline without retargeting replacements. */
  async selectText(options: SelectTextOptions = {}): Promise<void> {
    validateOptions('locator.selectText', options, ['force', 'timeout']);
    validateBoolean('locator.selectText.force', options.force);
    return this.run('selectText', { force: options.force ?? false }, options.timeout === undefined ? {} : { timeout: options.timeout });
  }
  scrollIntoViewIfNeeded(options: LocatorTimeoutOptions = {}): Promise<void> {
    return this.run('scrollIntoViewIfNeeded', {}, options);
  }
  click(options: ClickOptions = {}): Promise<void> { return this.pointer('click', options); }
  dblclick(options: Omit<ClickOptions, 'clickCount'> = {}): Promise<void> { return this.pointer('dblclick', options); }
  hover(options: HoverOptions = {}): Promise<void> { return this.pointer('hover', options); }
  check(options: CheckOptions = {}): Promise<void> { return this.pointer('check', options, true); }
  uncheck(options: CheckOptions = {}): Promise<void> { return this.pointer('uncheck', options, false); }
  async setChecked(checked: boolean, options: CheckOptions = {}): Promise<void> {
    if (typeof checked !== 'boolean') throw failure('InvalidArgumentError', 'locator.setChecked', 'checked must be a boolean');
    return this.pointer('setChecked', options, checked);
  }
  count(): Promise<number> { return this.run('count'); }
  async all(): Promise<Locator[]> { return Array.from({ length: await this.count() }, (_, index) => this.nth(index)); }
  allTextContents(): Promise<string[]> { return this.run('allTextContents'); }
  allInnerTexts(): Promise<string[]> { return this.run('allInnerTexts'); }
  textContent(options: LocatorTimeoutOptions = {}): Promise<string | null> { return this.run('textContent', {}, options); }
  innerText(options: LocatorTimeoutOptions = {}): Promise<string> { return this.run('innerText', {}, options); }
  innerHTML(options: LocatorTimeoutOptions = {}): Promise<string> { return this.run('innerHTML', {}, options); }
  getAttribute(name: string, options: LocatorTimeoutOptions = {}): Promise<string | null> { return this.run('getAttribute', { name }, options); }
  inputValue(options: LocatorTimeoutOptions = {}): Promise<string> { return this.run('inputValue', {}, options); }
  isVisible(options: LocatorTimeoutOptions = {}): Promise<boolean> { return this.run('isVisible', { state: 'visible' }, options); }
  isHidden(options: LocatorTimeoutOptions = {}): Promise<boolean> { return this.run('isHidden', { state: 'hidden' }, options); }
  isEnabled(options: LocatorTimeoutOptions = {}): Promise<boolean> { return this.run('isEnabled', { state: 'enabled' }, options); }
  isDisabled(options: LocatorTimeoutOptions = {}): Promise<boolean> { return this.run('isDisabled', { state: 'disabled' }, options); }
  isEditable(options: LocatorTimeoutOptions = {}): Promise<boolean> { return this.run('isEditable', { state: 'editable' }, options); }
  isChecked(options: LocatorTimeoutOptions = {}): Promise<boolean> { return this.run('isChecked', { state: 'checked' }, options); }
  async waitFor(options: LocatorTimeoutOptions & { state?: 'attached' | 'detached' | 'visible' | 'hidden' } = {}): Promise<void> {
    const { state = 'visible', ...timeout } = options;
    if (!['attached', 'detached', 'visible', 'hidden'].includes(state)) throw failure('InvalidArgumentError', 'locator.waitFor', 'invalid wait state');
    return this.run('waitFor', { state }, timeout);
  }
  fill(value: string, options: FillOptions = {}): Promise<void> { return this.actions.fill(value, options); }
  clear(options: FillOptions = {}): Promise<void> { return this.fill('', options); }
  focus(options: LocatorTimeoutOptions = {}): Promise<void> { return this.run('focus', {}, options); }
  blur(options: LocatorTimeoutOptions = {}): Promise<void> { return this.run('blur', {}, options); }
  selectOption(values: string | SelectOption | readonly string[] | readonly SelectOption[] | null, options: FillOptions = {}): Promise<string[]> { return this.actions.selectOption(values, options); }
}
