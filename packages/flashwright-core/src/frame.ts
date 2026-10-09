import { instrumentTraceMethods, tracePageOwner } from './trace-hooks.js';
import type { AssertionOptions, AssertionResult } from './assertions.js';
import type { Page } from './index.js';
import { LocatorScope, type LocatorTimeoutOptions } from './locator.js';
import { failure } from './errors.js';
import type { JSHandle, ElementHandle, Unboxed, SmartHandle } from './handles.js';
import type { WaitForSelectorOptions, WaitForSelectorOptionsNotHidden } from './element-resolution.js';
import type { InputFiles, FrameSetInputFilesOptions } from './file-inputs.js';

export interface FrameSnapshot { identifier: string; parent: string | null; name: string; url: string; navigationSequence: number; loader: string }

/** Identity is stable while the frame's document and URL can change. */
export class Frame extends LocatorScope {
  static { instrumentTraceMethods(this.prototype, 'Frame', frame => tracePageOwner(frame.owner), { evaluate: { method: 'evaluateExpression', parameters: ['expression', 'arg'] }, evaluateHandle: { method: 'evaluateExpressionHandle', parameters: ['expression', 'arg'] }, waitForSelector: { parameters: ['selector', 'options'] }, setInputFiles: { parameters: ['selector', 'files', 'options'] } }); }

  private detached = false;
  async setInputFiles(selector: string, files: InputFiles, options: FrameSetInputFilesOptions = {}): Promise<void> {
    if (this.detached) throw failure('TargetClosedError', 'frame.setInputFiles', 'frame has been detached');
    return this.owner.runFileInput({ frame: this.snapshot.identifier, selector }, files, options);
  }
  constructor(private readonly owner: Page, private snapshot: FrameSnapshot) { super(() => this); }
  runLocator<Result>(selector: string, action: string, parameters: object, options: LocatorTimeoutOptions): Promise<Result> {
    if (this.detached) return Promise.reject(failure('TargetClosedError', `locator.${action}`, 'frame has been detached'));
    return this.owner.runLocator(this.snapshot.identifier, selector, action, parameters, options);
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
