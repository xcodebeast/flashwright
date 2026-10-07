import type { AssertionOptions, AssertionResult } from './assertions.js';
import type { Page } from './index.js';
import { LocatorScope, type LocatorTimeoutOptions } from './locator.js';
import { failure } from './errors.js';

export interface FrameSnapshot { identifier: string; parent: string | null; name: string; url: string; navigationSequence: number }

/** Identity is stable while the frame's document and URL can change. */
export class Frame extends LocatorScope {
  private detached = false;
  constructor(private readonly owner: Page, private snapshot: FrameSnapshot) { super(() => this); }
  runLocator<Result>(selector: string, action: string, parameters: object, options: LocatorTimeoutOptions): Promise<Result> {
    if (this.detached) return Promise.reject(failure('TargetClosedError', `locator.${action}`, 'frame has been detached'));
    return this.owner.runLocator(this.snapshot.identifier, selector, action, parameters, options);
  }
  runAssertion(selector: string | null, options: AssertionOptions, timeout: number): Promise<AssertionResult> {
    if (this.detached) return Promise.reject(failure('TargetClosedError', 'assertion.run', 'frame has been detached'));
    return this.owner.runAssertion(this.snapshot.identifier, selector, options, timeout);
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
