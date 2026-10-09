import { extname } from 'node:path';
import { failure } from './errors.js';
import { validateBoolean, validateOptions } from './validation.js';

export interface PageScreenshotOptions {
  type?: 'png' | 'jpeg';
  quality?: number;
  path?: string;
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
  caret?: 'hide' | 'initial';
  animations?: 'allow' | 'disabled';
  style?: string;
  omitBackground?: boolean;
  scale?: 'css' | 'device';
  timeout?: number;
}

/** Validate the entire option set before requesting browser preparation or opening a file. */
export function prepareScreenshot(options: PageScreenshotOptions) {
  const method = 'page.screenshot';
  validateOptions(method, options, ['type', 'quality', 'path', 'fullPage', 'clip', 'caret', 'animations', 'style', 'omitBackground', 'scale', 'timeout']);
  for (const key of ['path', 'style'] as const) if (options[key] !== undefined && typeof options[key] !== 'string') throw failure('InvalidArgumentError', `${method}.${key}`, 'expected a string');
  for (const key of ['fullPage', 'omitBackground'] as const) validateBoolean(`${method}.${key}`, options[key]);
  for (const [key, values] of [['type', ['png', 'jpeg']], ['caret', ['hide', 'initial']], ['animations', ['allow', 'disabled']], ['scale', ['css', 'device']]] as const) {
    if (options[key] !== undefined && !(values as readonly string[]).includes(options[key]!)) throw failure('InvalidArgumentError', `${method}.${key}`, 'invalid screenshot option value');
  }
  let type = options.type;
  if (type === undefined && options.path) {
    const extension = extname(options.path);
    if (extension === '.png') type = 'png';
    else if (['.jpg', '.jpeg', '.jpe'].includes(extension)) type = 'jpeg';
    else throw failure('InvalidArgumentError', `${method}.path`, 'cannot infer a PNG or JPEG format from this file extension; specify type');
  }
  type ??= 'png';
  if (options.quality !== undefined && (type !== 'jpeg' || !Number.isInteger(options.quality) || options.quality < 0 || options.quality > 100)) throw failure('InvalidArgumentError', `${method}.quality`, 'quality requires JPEG and an integer from 0 to 100');
  if (options.clip !== undefined) {
    validateOptions(`${method}.clip`, options.clip, ['x', 'y', 'width', 'height']);
    for (const key of ['x', 'y', 'width', 'height'] as const) if (!Number.isFinite(options.clip[key])) throw failure('InvalidArgumentError', `${method}.clip.${key}`, 'expected a finite number');
    if (options.clip.width <= 0 || options.clip.height <= 0 || !Number.isFinite(options.clip.x + options.clip.width) || !Number.isFinite(options.clip.y + options.clip.height)) throw failure('InvalidArgumentError', `${method}.clip`, 'clip must have finite bounds and positive width and height');
  }
  const style = options.style ?? '';
  if (style.length > 100000) throw failure('ResourceLimitError', `${method}.style`, 'style exceeds 100000 UTF-16 units');
  return {
    path: options.path || undefined,
    parameters: { type, quality: options.quality, fullPage: options.fullPage ?? false, clip: options.clip, caret: options.caret ?? 'hide', animations: options.animations ?? 'allow', styleUnits: Array.from({ length: style.length }, (_, index) => style.charCodeAt(index)), omitBackground: options.omitBackground ?? false, scale: options.scale ?? 'device' },
  };
}
