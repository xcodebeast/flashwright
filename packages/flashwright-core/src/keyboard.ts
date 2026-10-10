import { instrumentTraceMethods, tracePageOwner } from './trace-hooks.js';
import type { Page } from './index.js';
import { failure } from './errors.js';
import { validateOptions } from './validation.js';

export interface KeyboardPressOptions { delay?: number }

/** Native text preserves Unicode scalar values; unsupported code units reject before input. */
function validateNativeText(text: string, method: string): void {
  if (typeof text !== 'string') throw failure('InvalidArgumentError', method, 'text must be a string');
  if (text.length > 100000) throw failure('ResourceLimitError', method, 'text exceeds 100000 UTF-16 units');
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) throw failure('UnsupportedFeatureError', method, 'native text input containing unpaired UTF-16 surrogates is not implemented');
}

/** Admission precedes trace ownership and its optional browser diagnostics. */
function prepareTextInsertionArguments(arguments_: readonly unknown[]): unknown[] {
  validateNativeText(arguments_[0] as string, 'keyboard.insertText');
  return [arguments_[0]];
}

/** Validate the complete sequence before a locator can focus an element or native input begins. */
export function prepareTyping(text: string, options: KeyboardPressOptions, method: string): { textUnits: number[]; delay?: number } {
  validateNativeText(text, method);
  if (options.delay !== undefined && (!Number.isFinite(options.delay) || options.delay < 0 || options.delay > 0xffffffff)) throw failure('InvalidArgumentError', method, 'delay must be a finite nonnegative number within the supported timer range');
  return { textUnits: Array.from({ length: text.length }, (_, index) => text.charCodeAt(index)), ...(options.delay === undefined ? {} : { delay: options.delay }) };
}

/** Page-level keyboard input preserves the browser's existing focus and selection. */
export class Keyboard {
  static { instrumentTraceMethods(this.prototype, 'Page', keyboard => tracePageOwner(keyboard.owner), { press: { method: 'keyboardPress', parameters: ['key', 'options'] }, type: { method: 'keyboardType', parameters: ['text', 'options'] }, insertText: { method: 'keyboardInsertText', parameters: ['text'], prepareArguments: prepareTextInsertionArguments } }, 'Keyboard'); }

  constructor(private readonly owner: Page) {}
  async press(key: string, options: KeyboardPressOptions = {}): Promise<void> {
    const method = 'keyboard.press';
    validateOptions(method, options, ['delay']);
    if (typeof key !== 'string') throw failure('InvalidArgumentError', method, 'key must be a string');
    if (key.length > 100000) throw failure('ResourceLimitError', method, 'key exceeds 100000 UTF-16 units');
    if (options.delay !== undefined && (!Number.isFinite(options.delay) || options.delay < 0 || options.delay > 0xffffffff)) throw failure('InvalidArgumentError', method, 'delay must be a finite nonnegative number within the supported timer range');
    await this.owner.pressKey(key, options);
  }
  async down(_key: string): Promise<void> { throw failure('UnsupportedFeatureError', 'keyboard.down', 'persistent held keys are not implemented'); }
  async up(_key: string): Promise<void> { throw failure('UnsupportedFeatureError', 'keyboard.up', 'persistent held keys are not implemented'); }
  async insertText(text: string): Promise<void> {
    await this.owner.insertKeyboardText(Array.from({ length: text.length }, (_, index) => text.charCodeAt(index)));
  }
  async type(text: string, options: KeyboardPressOptions = {}): Promise<void> {
    validateOptions('keyboard.type', options, ['delay']);
    await this.owner.typeText(prepareTyping(text, options, 'keyboard.type'));
  }
}
