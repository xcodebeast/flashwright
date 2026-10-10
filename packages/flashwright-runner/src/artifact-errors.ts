import { types } from 'node:util';
import type { TestInfo } from 'flashwright-upstream-runner/test';

/** Accumulate bounded data, then publish once: the runner sends attachment bytes at push time. */
export class ArtifactErrors {
  private readonly messages: string[] = [];
  private count = 0;
  private published = false;

  constructor(private readonly name: 'trace-error' | 'screenshot-error' | 'error-context-error', private readonly includeStack = false) {}

  record(error: unknown): void {
    ++this.count;
    if (this.messages.length >= 16) return;
    let message = 'Artifact operation failed with a non-data error.';
    if (typeof error === 'string') message = error.slice(0, 4096);
    else if (error && typeof error === 'object' && !types.isProxy(error)) {
      // Native Error.stack may be lazy and invoke Error.prepareStackTrace.
      const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') message = descriptor.value.slice(0, 4096);
      // Screenshots retain their established original-stack diagnostic. A formatting
      // failure must still preserve the test outcome and the safe message fallback.
      if (this.includeStack && types.isNativeError(error)) {
        try {
          const stack = (error as Error).stack;
          if (typeof stack === 'string') message = stack.slice(0, 4096);
        } catch {}
      }
    }
    this.messages.push(message);
  }

  publish(testInfo: Pick<TestInfo, 'attachments'>): void {
    if (this.published || !this.count) return;
    this.published = true;
    const omitted = this.count - this.messages.length;
    const kind = this.name === 'trace-error' ? 'trace' : this.name === 'screenshot-error' ? 'screenshot' : 'failure context';
    const body = Buffer.from(this.messages.join('\n\n') + (omitted ? `\n\n${omitted} additional ${kind} errors omitted.` : ''));
    testInfo.attachments.push({ name: this.name, contentType: 'text/plain', body });
  }
}
