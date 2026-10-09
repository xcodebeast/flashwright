import { failure } from './errors.js';
import { validateBoolean, validateOptions } from './validation.js';

export interface WaitForSelectorOptions {
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
  strict?: boolean;
  timeout?: number;
}
export type WaitForSelectorOptionsNotHidden = WaitForSelectorOptions & { state?: 'visible' | 'attached' };

/** Preserve selector text exactly and reject unsupported wait options before native allocation. */
export function prepareElementResolution(selector: string, options: WaitForSelectorOptions): { selector: number[]; strict: boolean; state: string } {
  const method = 'frame.waitForSelector';
  validateOptions(method, options, ['state', 'strict', 'timeout']);
  validateBoolean(`${method}.strict`, options.strict);
  if (typeof selector !== 'string') throw failure('InvalidArgumentError', method, 'selector must be a string');
  if (selector.length > 100000) throw failure('ResourceLimitError', method, 'selector exceeds 100000 UTF-16 units');
  const state = options.state === undefined ? 'visible' : options.state;
  if (!['attached', 'detached', 'visible', 'hidden'].includes(state)) throw failure('InvalidArgumentError', method, 'state must be attached, detached, visible or hidden');
  return { selector: Array.from({ length: selector.length }, (_, index) => selector.charCodeAt(index)), strict: options.strict ?? false, state };
}
