import { failure } from './errors.js';
import { validateBoolean } from './validation.js';

export interface ContextSettings {
  colorScheme?: 'light' | 'dark' | 'no-preference' | null;
  reducedMotion?: 'reduce' | 'no-preference' | null;
  forcedColors?: 'active' | 'none' | null;
  contrast?: 'more' | 'no-preference' | null;
  acceptDownloads?: boolean;
  ignoreHTTPSErrors?: boolean;
  javaScriptEnabled?: boolean;
}

/** Validate settings before allocating or restoring any native context. */
export function prepareContextSettings(settings: ContextSettings) {
  validateBoolean('browser.newContext.acceptDownloads', settings.acceptDownloads);
  validateBoolean('browser.newContext.ignoreHTTPSErrors', settings.ignoreHTTPSErrors);
  validateBoolean('browser.newContext.javaScriptEnabled', settings.javaScriptEnabled);
  for (const [name, values] of Object.entries({
    colorScheme: ['light', 'dark', 'no-preference'], reducedMotion: ['reduce', 'no-preference'],
    forcedColors: ['active', 'none'], contrast: ['more', 'no-preference'],
  })) {
    const value = settings[name as keyof ContextSettings];
    if (value !== undefined && value !== null && (typeof value !== 'string' || !values.includes(value)))
      throw failure('InvalidArgumentError', `browser.newContext.${name}`, `expected ${values.join(', ')} or null`);
  }
  return {
    ...(settings.colorScheme === undefined ? {} : { colorScheme: settings.colorScheme }),
    ...(settings.reducedMotion === undefined ? {} : { reducedMotion: settings.reducedMotion }),
    ...(settings.forcedColors === undefined ? {} : { forcedColors: settings.forcedColors }),
    ...(settings.contrast === undefined ? {} : { contrast: settings.contrast }),
    acceptDownloads: settings.acceptDownloads ?? true,
    ...(settings.ignoreHTTPSErrors === undefined ? {} : { ignoreHTTPSErrors: settings.ignoreHTTPSErrors }),
    ...(settings.javaScriptEnabled === undefined ? {} : { javaScriptEnabled: settings.javaScriptEnabled }),
  };
}
