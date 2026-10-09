import { failure } from './errors.js';

export function validateOptions(method: string, value: object, supported: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('InvalidArgumentError', method, 'options must be an object');
  for (const key of Object.keys(value)) if (!supported.includes(key)) throw failure('UnsupportedFeatureError', `${method}.${key}`, 'option is not implemented in this development build');
}

export function validateBoolean(method: string, value: unknown): void {
  if (value !== undefined && typeof value !== 'boolean') throw failure('InvalidArgumentError', method, 'expected a boolean');
}
