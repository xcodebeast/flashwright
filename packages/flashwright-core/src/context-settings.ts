import { validateBoolean } from './validation.js';

export interface ContextSettings {
  ignoreHTTPSErrors?: boolean;
  javaScriptEnabled?: boolean;
}

/** Validate settings before allocating or restoring any native context. */
export function prepareContextSettings(settings: ContextSettings) {
  validateBoolean('browser.newContext.ignoreHTTPSErrors', settings.ignoreHTTPSErrors);
  validateBoolean('browser.newContext.javaScriptEnabled', settings.javaScriptEnabled);
  return {
    ...(settings.ignoreHTTPSErrors === undefined ? {} : { ignoreHTTPSErrors: settings.ignoreHTTPSErrors }),
    ...(settings.javaScriptEnabled === undefined ? {} : { javaScriptEnabled: settings.javaScriptEnabled }),
  };
}
