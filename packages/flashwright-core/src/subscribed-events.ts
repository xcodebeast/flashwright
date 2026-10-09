import { instrumentTraceCallbacks } from './trace-hooks.js';
import { EventEmitter } from 'node:events';
import { failure } from './errors.js';

// Adapted from @types/node's EventEmitter types to preserve fluent `this` and callback inference.
type EventKey<Event, Events> = Events extends [never] ? string | symbol : Event | keyof Events;
type EventListener<Event, Events> = Events extends [never] ? (...values: unknown[]) => void
  : Event extends keyof Events ? Events[Event] extends unknown[] ? (...values: Events[Event]) => void : never : never;

/** Every EventEmitter registration form updates capture, including once and removeAllListeners. */
export class SubscribedEventEmitter<Events extends { [Event in keyof Events]: unknown[] }> extends EventEmitter<Events> {
  private readonly subscribed = new Set<string>();
  private readonly subscriptions: readonly [string, (enabled: boolean) => void][];
  constructor(subscriptions: Readonly<Record<string, (enabled: boolean) => void>>) { super(); this.subscriptions = Object.entries(subscriptions); }
  private changeSubscription(change: () => this): this {
    const result = change();
    for (const [event, changed] of this.subscriptions) {
      const enabled = this.listenerCount(event as never) !== 0;
      if (enabled === this.subscribed.has(event)) continue;
      if (enabled) this.subscribed.add(event); else this.subscribed.delete(event);
      changed(enabled);
    }
    return result;
  }
  override on<Event>(event: EventKey<Event, Events>, listener: EventListener<Event, Events>): this { return this.changeSubscription(() => super.on(event, listener)); }
  override addListener<Event>(event: EventKey<Event, Events>, listener: EventListener<Event, Events>): this { return this.changeSubscription(() => super.addListener(event, listener)); }
  override prependListener<Event>(event: EventKey<Event, Events>, listener: EventListener<Event, Events>): this { return this.changeSubscription(() => super.prependListener(event, listener)); }
  override removeListener<Event>(event: EventKey<Event, Events>, listener: EventListener<Event, Events>): this { return this.changeSubscription(() => super.removeListener(event, listener)); }
  override off<Event>(event: EventKey<Event, Events>, listener: EventListener<Event, Events>): this { return this.changeSubscription(() => super.off(event, listener)); }
  override removeAllListeners(event?: EventKey<unknown, Events>, removalOptions?: { behavior?: 'wait' | 'ignoreErrors' | 'default' }): this {
    if (removalOptions !== undefined) throw failure('UnsupportedFeatureError', 'removeAllListeners', 'async listener removal options are not implemented');
    return this.changeSubscription(() => event === undefined ? super.removeAllListeners() : super.removeAllListeners(event));
  }
}

instrumentTraceCallbacks(SubscribedEventEmitter.prototype, 'emit');
