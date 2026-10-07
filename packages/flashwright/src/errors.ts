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

export function fromRecord(record: ErrorRecord): FlashwrightError {
  const constructors: Record<string, new (record: ErrorRecord) => FlashwrightError> = {
    UnsupportedFeatureError, InvalidArgumentError, TimeoutError, TargetClosedError,
    BrowserDisconnectedError, ProtocolError, ResourceLimitError, CancelledError, EvaluationError, NavigationError, PageCrashedError,
  };
  return new (constructors[record.code] ?? ProtocolError)(record);
}

export function failure(code: string, method: string, message: string): FlashwrightError {
  return fromRecord({ code, method, message, referenceVersion: '1.60.0', browser: 'chromium' });
}

export const errors = { TimeoutError };
