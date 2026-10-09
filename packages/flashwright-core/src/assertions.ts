/** Engine-facing assertion contract used by the separately packaged runner adapter. */
export interface ExpectedText {
  string?: string;
  regexSource?: string;
  regexFlags?: string;
  matchSubstring?: boolean;
  normalizeWhiteSpace?: boolean;
  ignoreCase?: boolean;
}
export interface AssertionOptions {
  expression: string;
  isNot: boolean;
  expectedText?: ExpectedText[];
  expectedNumber?: number;
  expectedValue?: { checked?: boolean; indeterminate?: boolean };
  expressionArg?: string;
  useInnerText?: boolean;
}
export interface AssertionResult {
  observed: boolean;
  matches: boolean;
  received?: unknown;
  missingReceived: boolean;
  timedOut: boolean;
  diagnosticTruncated: boolean;
}
