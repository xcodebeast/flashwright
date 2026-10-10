import { instrumentTraceMethods, tracePageOwner } from './trace-hooks.js';
import type { AssertionOptions, AssertionResult } from './assertions.js';
import type { Page } from './index.js';
import { LocatorScope, type LocatorTimeoutOptions, type ClickOptions, type HoverOptions, type CheckOptions, type FillOptions, type PressOptions, type SelectOption } from './locator.js';
import { failure } from './errors.js';
import { validateBoolean } from './validation.js';
import { SelectorActions, selectorActionTraceMethods, type SelectorOptions } from './selector-actions.js';
import type { JSHandle, ElementHandle, Unboxed, SmartHandle } from './handles.js';
import type { WaitForSelectorOptions, WaitForSelectorOptionsNotHidden } from './element-resolution.js';
import type { InputFiles, FrameSetInputFilesOptions } from './file-inputs.js';

export interface FrameSnapshot { identifier: string; parent: string | null; name: string; url: string; navigationSequence: number; loader: string }

/** Identity is stable while the frame's document and URL can change. */
export class Frame extends LocatorScope {
  static { instrumentTraceMethods(this.prototype, 'Frame', frame => tracePageOwner(frame.owner), { ...selectorActionTraceMethods, runAssertion: { method: 'expect', apiName: 'frame._expect', parameters: ['selector', 'options', 'timeout'] }, evaluate: { method: 'evaluateExpression', parameters: ['expression', 'arg'] }, evaluateHandle: { method: 'evaluateExpressionHandle', parameters: ['expression', 'arg'] }, waitForSelector: { parameters: ['selector', 'options'] }, setInputFiles: { parameters: ['selector', 'files', 'options'] } }); }

  private detached = false;
  async setInputFiles(selector: string, files: InputFiles, options: FrameSetInputFilesOptions = {}): Promise<void> {
    if (this.detached) throw failure('TargetClosedError', 'frame.setInputFiles', 'frame has been detached');
    return this.owner.runFileInput({ frame: this.snapshot.identifier, selector }, files, options);
  }
  constructor(private readonly owner: Page, private snapshot: FrameSnapshot) { super(() => this); }
  runLocator<Result>(selector: string, action: string, parameters: object, options: LocatorTimeoutOptions, strict = true): Promise<Result> {
    if (this.detached) return Promise.reject(failure('TargetClosedError', `locator.${action}`, 'frame has been detached'));
    return this.owner.runLocator(this.snapshot.identifier, selector, action, parameters, options, strict);
  }
  /** Keep selector cardinality separate from action options and preserve it through native retries. */
  private selectorAction<Options extends object>(selector: string, action: string, options: SelectorOptions<Options>): { actions: SelectorActions; options: Omit<SelectorOptions<Options>, 'strict'> } {
    const method = `frame.${action}`;
    if (typeof selector !== 'string') throw failure('InvalidArgumentError', method, 'selector must be a string');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw failure('InvalidArgumentError', method, 'options must be an object');
    validateBoolean(`${method}.strict`, options.strict);
    const { strict = false, ...actionOptions } = options;
    return { actions: new SelectorActions((operation, parameters, timeout) => this.runLocator(selector, operation, parameters, timeout, strict), 'frame'), options: actionOptions };
  }
  async click(selector: string, options: SelectorOptions<ClickOptions> = {}): Promise<void> {
    const target = this.selectorAction(selector, 'click', options);
    return target.actions.pointer('click', target.options);
  }
  async dblclick(selector: string, options: SelectorOptions<Omit<ClickOptions, 'clickCount'>> = {}): Promise<void> {
    const target = this.selectorAction(selector, 'dblclick', options);
    return target.actions.pointer('dblclick', target.options);
  }
  async hover(selector: string, options: SelectorOptions<HoverOptions> = {}): Promise<void> {
    const target = this.selectorAction(selector, 'hover', options);
    return target.actions.pointer('hover', target.options);
  }
  async check(selector: string, options: SelectorOptions<CheckOptions> = {}): Promise<void> {
    const target = this.selectorAction(selector, 'check', options);
    return target.actions.pointer('check', target.options, true);
  }
  async uncheck(selector: string, options: SelectorOptions<CheckOptions> = {}): Promise<void> {
    const target = this.selectorAction(selector, 'uncheck', options);
    return target.actions.pointer('uncheck', target.options, false);
  }
  async setChecked(selector: string, checked: boolean, options: SelectorOptions<CheckOptions> = {}): Promise<void> {
    if (typeof checked !== 'boolean') throw failure('InvalidArgumentError', 'frame.setChecked', 'checked must be a boolean');
    const target = this.selectorAction(selector, 'setChecked', options);
    return target.actions.pointer('setChecked', target.options, checked);
  }
  async fill(selector: string, value: string, options: SelectorOptions<FillOptions> = {}): Promise<void> {
    const target = this.selectorAction(selector, 'fill', options);
    return target.actions.fill(value, target.options);
  }
  async focus(selector: string, options: SelectorOptions<LocatorTimeoutOptions> = {}): Promise<void> {
    const target = this.selectorAction(selector, 'focus', options);
    return target.actions.focus(target.options);
  }
  async selectOption(selector: string, values: string | SelectOption | readonly string[] | readonly SelectOption[] | null, options: SelectorOptions<FillOptions> = {}): Promise<string[]> {
    const target = this.selectorAction(selector, 'selectOption', options);
    return target.actions.selectOption(values, target.options);
  }
  async press(selector: string, key: string, options: SelectorOptions<PressOptions> = {}): Promise<void> {
    const target = this.selectorAction(selector, 'press', options);
    return target.actions.press(key, target.options);
  }
  async type(selector: string, text: string, options: SelectorOptions<PressOptions> = {}): Promise<void> {
    const target = this.selectorAction(selector, 'type', options);
    return target.actions.pressSequentially(text, target.options, 'type');
  }
  runAssertion(selector: string | null, options: AssertionOptions, timeout: number): Promise<AssertionResult> {
    if (this.detached) return Promise.reject(failure('TargetClosedError', 'assertion.run', 'frame has been detached'));
    return this.owner.runAssertion(this.snapshot.identifier, selector, options, timeout);
  }
  async waitForSelector<Tag extends keyof HTMLElementTagNameMap>(selector: Tag, options?: WaitForSelectorOptionsNotHidden): Promise<ElementHandle<HTMLElementTagNameMap[Tag]>>;
  async waitForSelector(selector: string, options?: WaitForSelectorOptionsNotHidden): Promise<ElementHandle<SVGElement | HTMLElement>>;
  async waitForSelector<Tag extends keyof HTMLElementTagNameMap>(selector: Tag, options: WaitForSelectorOptions): Promise<ElementHandle<HTMLElementTagNameMap[Tag]> | null>;
  async waitForSelector(selector: string, options: WaitForSelectorOptions): Promise<ElementHandle<SVGElement | HTMLElement> | null>;
  async waitForSelector(selector: string, options: WaitForSelectorOptions = {}): Promise<ElementHandle<SVGElement | HTMLElement> | null> {
    if (this.detached) throw failure('TargetClosedError', 'frame.waitForSelector', 'frame has been detached');
    return this.owner.runSelectorWait(this.snapshot.identifier, selector, options);
  }
  async evaluate<Result, Argument>(pageFunction: string | ((argument: Unboxed<Argument>) => Result | Promise<Result>), argument: Argument): Promise<Result>;
  async evaluate<Result>(pageFunction: string | (() => Result | Promise<Result>)): Promise<Result>;
  async evaluate(pageFunction: string | Function, argument?: unknown): Promise<unknown> {
    if (this.detached) throw failure('EvaluationError', 'frame.evaluate', 'frame has been detached');
    return this.owner.runEvaluation('frame.evaluate', pageFunction, argument, { frame: this.snapshot.identifier });
  }
  async evaluateHandle<Result, Argument>(pageFunction: string | ((argument: Unboxed<Argument>) => Result | Promise<Result>), argument: Argument): Promise<SmartHandle<Result>>;
  async evaluateHandle<Result>(pageFunction: string | (() => Result | Promise<Result>)): Promise<SmartHandle<Result>>;
  async evaluateHandle(pageFunction: string | Function, argument?: unknown): Promise<JSHandle> {
    if (this.detached) throw failure('EvaluationError', 'frame.evaluateHandle', 'frame has been detached');
    return this.owner.runEvaluation('frame.evaluateHandle', pageFunction, argument, { frame: this.snapshot.identifier }) as Promise<JSHandle>;
  }
  page(): Page { return this.owner; }
  name(): string { return this.snapshot.name; }
  url(): string { return this.snapshot.url; }
  parentFrame(): Frame | null { return this.snapshot.parent ? this.owner.frameByIdentifier(this.snapshot.parent) : null; }
  childFrames(): Frame[] { return this.owner.frames().filter(frame => frame.parentFrame() === this); }
  isDetached(): boolean { return this.detached; }
  didNavigate(snapshot: FrameSnapshot): void {
    if (snapshot.navigationSequence >= this.snapshot.navigationSequence) this.snapshot = snapshot;
  }
  didDetach(): void { this.detached = true; }
}
