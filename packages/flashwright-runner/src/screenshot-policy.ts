import { failure, type PageScreenshotOptions } from '@flashwright/core';

export type ScreenshotMode = 'off' | 'on' | 'only-on-failure' | 'on-first-failure';
export interface ScreenshotPolicy {
  mode: ScreenshotMode;
  options: Pick<PageScreenshotOptions, 'fullPage' | 'omitBackground'>;
}

/** Runner policy accepts the pinned public option set, before any browser fixture runs. */
export function screenshotPolicy(value: unknown): ScreenshotPolicy {
  const supplied = typeof value === 'string' ? { mode: value } : value;
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
    throw failure('InvalidArgumentError', 'test.use.screenshot', 'expected a screenshot mode or options object');
  }
  const settings = supplied as Record<string, unknown>;
  for (const name of Object.keys(settings)) {
    if (!['mode', 'fullPage', 'omitBackground'].includes(name) && settings[name] !== undefined) {
      throw failure('UnsupportedFeatureError', `test.use.screenshot.${name}`, 'screenshot policy option is not implemented');
    }
  }
  if (!['off', 'on', 'only-on-failure', 'on-first-failure'].includes(settings.mode as string)) {
    throw failure('InvalidArgumentError', 'test.use.screenshot.mode', 'expected off, on, only-on-failure or on-first-failure');
  }
  for (const name of ['fullPage', 'omitBackground']) {
    if (settings[name] !== undefined && typeof settings[name] !== 'boolean') {
      throw failure('InvalidArgumentError', `test.use.screenshot.${name}`, 'expected a boolean');
    }
  }
  return Object.freeze({ mode: settings.mode as ScreenshotMode, options: Object.freeze({
    ...(settings.fullPage === undefined ? {} : { fullPage: settings.fullPage as boolean }),
    ...(settings.omitBackground === undefined ? {} : { omitBackground: settings.omitBackground as boolean }),
  }) });
}
