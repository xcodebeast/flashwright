import type { Page } from './index.js';
import { failure } from './errors.js';
import { validateOptions } from './validation.js';

export interface KeyboardPressOptions { delay?: number }

/** Page-level keyboard input preserves the browser's existing focus and selection. */
export class Keyboard {
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
  async insertText(_text: string): Promise<void> { throw failure('UnsupportedFeatureError', 'keyboard.insertText', 'direct keyboard text insertion is not implemented'); }
  async type(_text: string, _options: KeyboardPressOptions = {}): Promise<void> { throw failure('UnsupportedFeatureError', 'keyboard.type', 'sequential keyboard typing is not implemented'); }
}
