import { runTraceUserCallback } from './trace-hooks.js';
import type { EventEmitter } from 'node:events';
import type { EngineClient } from './client.js';
import { FlashwrightError, failure, fromRecord } from './errors.js';

/** One public deadline and owner lifetime cover native stages and host URL callbacks. */
export class NavigationWaiter {
  private readonly started = performance.now();
  private readonly termination: Promise<never>;
  private rejectTermination!: (error: Error) => void;
  private terminalError: Error | undefined;
  private readonly timer: ReturnType<typeof setTimeout> | undefined;
  private readonly closed = () => this.fail(failure('TargetClosedError', this.method, 'page closed while waiting for navigation'));
  private readonly crashed = () => this.fail(failure('PageCrashedError', this.method, 'page crashed while waiting for navigation'));

  constructor(private readonly page: EventEmitter, private readonly client: EngineClient, private readonly method: string, private readonly timeout: number) {
    this.termination = new Promise((_, reject) => { this.rejectTermination = reject; });
    this.termination.catch(() => {});
    page.on('close', this.closed);
    page.on('crash', this.crashed);
    this.timer = timeout === 0 ? undefined : setTimeout(() => this.fail(failure('TimeoutError', method, 'navigation wait exceeded its deadline')), timeout);
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.rejectTermination(error);
  }

  private remainingTimeout(): number {
    if (this.terminalError) throw this.terminalError;
    if (this.timeout === 0) return 0;
    const remaining = this.timeout - (performance.now() - this.started);
    if (remaining <= 0) throw failure('TimeoutError', this.method, 'navigation wait exceeded its deadline');
    return remaining;
  }

  async race<Value>(promise: Promise<Value>): Promise<Value> {
    return Promise.race([promise, this.termination]);
  }

  async predicate(callback: () => boolean | Promise<boolean>): Promise<boolean> {
    this.remainingTimeout();
    return this.race(Promise.resolve(runTraceUserCallback(callback)));
  }

  async request<Value>(method: string, parameters: object): Promise<Value> {
    try {
      return await this.race(this.client.request(method, parameters, this.remainingTimeout())) as Value;
    } catch (error) {
      // Only native-stage errors are relabelled; a user predicate's thrown value stays intact.
      if (error instanceof FlashwrightError && error.details.method !== this.method) {
        const publicError = fromRecord({ ...error.details, method: this.method });
        if (error.stack) publicError.stack += `\nNative operation:\n${error.stack}`;
        throw publicError;
      }
      throw error;
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.page.off('close', this.closed);
    this.page.off('crash', this.crashed);
  }
}
