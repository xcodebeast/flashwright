/** Engine-facing assertion contract used by the separately packaged runner adapter. */
export interface ExpectedText {
  string?: string;
  regexSource?: string;
  regexFlags?: string;
  matchSubstring?: boolean;
  normalizeWhiteSpace?: boolean;
  ignoreCase?: boolean;
}
/** JSON-shaped output of the pinned ARIA template parser, including regex descriptors. */
export interface AriaSnapshotTemplate {
  kind: 'role' | 'text';
  role?: string;
  name?: string | { pattern: string };
  text?: { raw: string; normalized: string };
  children?: AriaSnapshotTemplate[];
  containerMode?: 'contain' | 'equal' | 'deep-equal';
  props?: Record<string, { raw: string; normalized: string }>;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  active?: boolean;
  level?: number;
  pressed?: boolean | 'mixed';
  selected?: boolean;
}
export interface AssertionOptions {
  expression: string;
  isNot: boolean;
  expectedText?: ExpectedText[];
  expectedNumber?: number;
  expectedValue?: { checked?: boolean; indeterminate?: boolean } | AriaSnapshotTemplate;
  ariaSnapshotCapture?: 'always' | 'mismatch';
  includeAriaSnapshot?: boolean;
  expressionArg?: string;
  useInnerText?: boolean;
  pseudo?: 'before' | 'after';
}
export interface AssertionResult {
  observed: boolean;
  matches: boolean;
  received?: unknown;
  ariaSnapshot?: string;
  missingReceived: boolean;
  timedOut: boolean;
  diagnosticTruncated: boolean;
}
