export interface ErrorRecord {
  code: string;
  method: string;
  message: string;
  messageUtf16?: number[];
  cleanup?: string;
  diagnostics?: unknown;
  browserErrorCode?: number;
  referenceVersion?: string;
  browser?: string;
  inputDelivery?: string;
}

export function errorMessage(details: ErrorRecord): string {
  return details.messageUtf16 ? details.messageUtf16.map(unit => String.fromCharCode(unit)).join('') : details.message;
}

export class FlashwrightError extends Error {
  readonly details: ErrorRecord;
  constructor(details: ErrorRecord) {
    super(`${details.method}: ${errorMessage(details)}`);
    this.name = details.code;
    this.details = details;
  }
}
export class UnsupportedFeatureError extends FlashwrightError {}
export class InvalidArgumentError extends FlashwrightError {}
export class TimeoutError extends FlashwrightError {}
export class TargetClosedError extends FlashwrightError {}
export class BrowserDisconnectedError extends FlashwrightError {}
export class ProtocolError extends FlashwrightError {}
export class ResourceLimitError extends FlashwrightError {}
export class CancelledError extends FlashwrightError {}
export class EvaluationError extends FlashwrightError {}
export class NavigationError extends FlashwrightError {}
export class PageCrashedError extends FlashwrightError {}

const errorConstructors: Record<string, new (record: ErrorRecord) => FlashwrightError> = {
  Error: FlashwrightError,
  UnsupportedFeatureError, InvalidArgumentError, TimeoutError, TargetClosedError,
  BrowserDisconnectedError, ProtocolError, ResourceLimitError, CancelledError, EvaluationError, NavigationError, PageCrashedError,
};
let isolatedErrorConstructor: ErrorConstructor | undefined;

/** Bun materializes native stacks even on replacement; allocate attributed errors in a private realm. */
function recordedError(record: ErrorRecord, attributed: boolean): FlashwrightError {
  const constructor = errorConstructors[record.code] ?? ProtocolError;
  if (!attributed || !process.versions.bun) return new constructor(record);
  // Lazy initialization leaves successful commands and ordinary Error construction unchanged.
  isolatedErrorConstructor ??= require('node:vm').runInNewContext('Error') as ErrorConstructor;
  const error = Reflect.construct(isolatedErrorConstructor, [`${record.method}: ${errorMessage(record)}`], constructor) as FlashwrightError;
  Object.defineProperties(error, {
    name: { value: record.code, enumerable: true, writable: true, configurable: true },
    details: { value: record, enumerable: true, writable: true, configurable: true },
  });
  return error;
}

const maximumCommandStackCharacters = 32768;
const stackTruncationNotice = '\n[Command stack truncated: character limit reached.]';

function boundedCommandStack(text: string, allowance: number): string {
  if (text.length <= allowance) return text;
  let end = allowance - stackTruncationNotice.length;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return text.slice(0, end) + stackTruncationNotice;
}

/** Native replies use the captured command caller without evaluating global stack-formatting hooks. */
export function fromRecord(record: ErrorRecord, callSite?: string): FlashwrightError {
  const error = recordedError(record, !!callSite);
  if (callSite) {
    const caller = boundedCommandStack(callSite, maximumCommandStackCharacters / 2);
    const separator = '\nCalled from:\n';
    const title = boundedCommandStack(`${error.name}: ${error.message}`, maximumCommandStackCharacters - caller.length - separator.length);
    Object.defineProperty(error, 'stack', { value: title + separator + caller, enumerable: false, writable: true, configurable: true });
  }
  return error;
}

export function failure(code: string, method: string, message: string, callSite?: string): FlashwrightError {
  return fromRecord({ code, method, message, referenceVersion: '1.60.0', browser: 'chromium' }, callSite);
}

/** Each pending request owns its caller; never mutate a transport failure shared with other requests. */
export function attributeRequestFailure(error: Error, callSite: string | undefined): Error {
  if (!callSite || !(error instanceof FlashwrightError)) return error;
  const prototype = Object.getPrototypeOf(error);
  if (!Object.values(errorConstructors).some(constructor => constructor.prototype === prototype)) return error;
  const attributed = fromRecord(error.details, callSite);
  if (Object.getPrototypeOf(attributed) !== prototype || attributed.name !== error.name || attributed.message !== error.message) return error;
  const cause = Object.getOwnPropertyDescriptor(error, 'cause');
  if (cause) Object.defineProperty(attributed, 'cause', cause);
  return attributed;
}

export const errors = { TimeoutError };
