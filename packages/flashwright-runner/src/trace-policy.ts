import { failure } from '@flashwright/core';

const modes = ['off', 'on', 'retain-on-failure', 'on-first-retry', 'on-all-retries', 'retain-on-first-failure', 'retain-on-failure-and-retries', 'retry-with-trace'];
const booleanOptions = ['screenshots', 'snapshots', 'sources', 'attachments', 'live'];

/** Reject unsupported policy requests before the public runner starts browser fixtures or tests. */
export function validateTracePolicy(value: unknown): void {
  const settings = typeof value === 'string' ? { mode: value } : value;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw failure('InvalidArgumentError', 'test.use.trace', 'expected a trace mode or options object');
  }
  const options = settings as Record<string, unknown>;
  for (const name of Object.keys(options)) {
    if (name !== 'mode' && !booleanOptions.includes(name) && options[name] !== undefined) {
      throw failure('UnsupportedFeatureError', `test.use.trace.${name}`, 'trace policy option is not implemented');
    }
  }
  if (options.mode !== undefined && !modes.includes(options.mode as string)) {
    throw failure('InvalidArgumentError', 'test.use.trace.mode', 'expected a supported trace retention mode');
  }
  for (const name of booleanOptions) {
    if (options[name] !== undefined && typeof options[name] !== 'boolean') {
      throw failure('InvalidArgumentError', `test.use.trace.${name}`, 'expected a boolean');
    }
  }
  if (options.live) throw failure('UnsupportedFeatureError', 'test.use.trace.live', 'live runner traces are not implemented');
}
