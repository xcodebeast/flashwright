import { failure } from './errors.js';

export const isSubscriptionControl = (method: string): boolean => ['page.dialog.subscribe', 'context.dialog.subscribe', 'page.console.subscribe', 'context.console.subscribe'].includes(method);
export const isDialogHandling = (method: string): boolean => method === 'dialog.accept' || method === 'dialog.dismiss';

export interface EventControlTicket {
  readonly predecessor: Promise<void> | undefined;
  complete(): void;
  fail(error: unknown): void;
}

/** Controls finish at acknowledgement; handling releases its ordering ticket at admission. */
export class EventControlLane {
  private tail: Promise<void> | undefined;
  private queued = 0;

  predecessor(): Promise<void> | undefined { return this.tail; }

  reserve(method: string, maximumQueued: number): EventControlTicket {
    if (this.queued >= maximumQueued) throw failure('ResourceLimitError', method, 'event control queue capacity exhausted');
    const predecessor = this.tail;
    let complete!: () => void;
    let fail!: (error: unknown) => void;
    const completed = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    this.queued++;
    // An expired later caller cannot release capacity or overtake an unfinished predecessor.
    const tail = Promise.allSettled([predecessor, completed]).then(results => {
      this.queued--;
      if (this.tail === tail) this.tail = undefined;
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    });
    void tail.catch(() => {});
    this.tail = tail;
    return { predecessor, complete, fail };
  }
}
