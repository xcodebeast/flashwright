import { EventEmitter } from 'node:events';
import type { EngineClient } from './client.js';
import type { Page } from './index.js';
import { type JSHandle, receivedHandles } from './handles.js';
import { failure } from './errors.js';
import { createValueCodec } from './serialization.cjs';

export type ConsoleMessageType = 'log' | 'debug' | 'info' | 'error' | 'warning' | 'dir' | 'dirxml' | 'table' | 'trace' | 'clear' | 'startGroup' | 'startGroupCollapsed' | 'endGroup' | 'assert' | 'profile' | 'profileEnd' | 'count' | 'time' | 'timeEnd';
interface ConsoleLocation { url: string; line: number; column: number; lineNumber: number; columnNumber: number }
interface PreviewProperty { name: string; value?: string }
interface RemoteObject { type: string; subtype?: string; description?: string; preview?: { properties: PreviewProperty[] } }
interface ConsolePayload { source: 'api' | 'log'; consoleJson: string; group: string | null; handles: { primitive: unknown }[] }
const codec = createValueCodec();

// Adapted from @types/node's EventEmitter types to preserve fluent `this` and callback inference.
type EventKey<Event, Events> = Events extends [never] ? string | symbol : Event | keyof Events;
type EventListener<Event, Events> = Events extends [never] ? (...values: unknown[]) => void
  : Event extends keyof Events ? Events[Event] extends unknown[] ? (...values: Events[Event]) => void : never : never;

/** Every EventEmitter registration form updates capture, including once and removeAllListeners. */
export class ConsoleEmitter<Events extends { [Event in keyof Events]: unknown[] }> extends EventEmitter<Events> {
  private consoleSubscribed = false;
  constructor(private readonly subscriptionChanged: (enabled: boolean) => void) { super(); }
  private changeSubscription(change: () => this): this {
    const result = change();
    const enabled = this.listenerCount('console' as never) !== 0;
    if (enabled !== this.consoleSubscribed) { this.consoleSubscribed = enabled; this.subscriptionChanged(enabled); }
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

/** A message snapshots diagnostics while its argument handles retain their original objects. */
export class ConsoleMessage {
  constructor(
    private readonly owner: Page,
    private readonly messageType: ConsoleMessageType,
    private readonly messageText: string,
    private readonly arguments_: JSHandle[],
    private readonly sourceLocation: ConsoleLocation,
    private readonly time: number,
  ) {}
  type(): ConsoleMessageType { return this.messageType; }
  text(): string { return this.messageText; }
  args(): JSHandle[] { return [...this.arguments_]; }
  location(): ConsoleLocation { return { ...this.sourceLocation }; }
  timestamp(): number { return this.time; }
  page(): Page { return this.owner; }
  worker(): null { return null; }
}

/** Chromium previews follow the pinned reference; DOM handles keep their initial node preview. */
function remotePreview(object: RemoteObject): string {
  if (object.subtype === 'node') return 'JSHandle@node';
  if (object.description === 'Object' && object.preview) return `{${object.preview.properties.map(property => `${property.name}: ${property.value}`).join(', ')}}`;
  if (object.subtype === 'array' && object.preview) {
    const entries = object.preview.properties
      .map(property => ({ index: +property.name, value: property.value }))
      .filter(entry => !Number.isNaN(entry.index) && entry.index >= 0)
      .sort((first, second) => first.index - second.index);
    let lastIndex = -1;
    const tokens: string[] = [];
    for (const entry of entries) {
      const emptyItems = entry.index - lastIndex - 1;
      if (emptyItems === 1) tokens.push('empty');
      else if (emptyItems > 1) tokens.push(`empty x ${emptyItems}`);
      tokens.push(String(entry.value));
      lastIndex = entry.index;
    }
    return `[${tokens.join(', ')}]`;
  }
  return object.description || `JSHandle@${object.subtype || object.type}`;
}

export function consoleMessage(owner: Page, client: EngineClient, pageIdentifier: string, parameters: unknown): ConsoleMessage {
  const payload = parameters as ConsolePayload;
  if (!payload || typeof payload.consoleJson !== 'string' || !Array.isArray(payload.handles)) throw failure('ProtocolError', 'console', 'driver omitted console metadata');
  const event = JSON.parse(payload.consoleJson);
  let handles: JSHandle[] = [];
  let location: { url?: string; lineNumber?: number; columnNumber?: number };
  let type: string;
  let text: string;
  let timestamp: number;
  if (payload.source === 'api') {
    if (!Array.isArray(event.args) || event.args.length !== payload.handles.length) throw failure('ProtocolError', 'console', 'console arguments and handle identities differ');
    const previews = event.args.map((object: RemoteObject, index: number) => {
      const primitive = payload.handles[index]!.primitive;
      return primitive !== null ? String(codec.decode(primitive)) : remotePreview(object);
    });
    handles = receivedHandles(owner, client, pageIdentifier, payload, previews).map(value => value.handle);
    location = event.stackTrace?.callFrames?.[0] ?? {};
    type = event.type;
    text = previews.join(' ');
    timestamp = event.timestamp;
  } else if (payload.source === 'log') {
    location = { url: event.entry?.url, lineNumber: event.entry?.lineNumber, columnNumber: 0 };
    type = event.entry?.level;
    text = event.entry?.text;
    timestamp = event.entry?.timestamp;
  } else throw failure('ProtocolError', 'console', 'unknown console event source');
  if (typeof type !== 'string' || typeof text !== 'string' || !Number.isFinite(timestamp)) throw failure('ProtocolError', 'console', 'invalid console message fields');
  const line = location.lineNumber || 0;
  const column = location.columnNumber || 0;
  return new ConsoleMessage(owner, type as ConsoleMessageType, text, handles, { url: location.url || '', line, column, lineNumber: line, columnNumber: column }, timestamp);
}
