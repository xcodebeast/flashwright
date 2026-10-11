import type { BrowserContextOptions } from './index.js';
import type { APIRequestContextOptions } from './api-request.js';
import { failure } from './errors.js';
import { validateTimeout } from './waits.js';

export interface RunnerContextDefaults {
  contextOptions: BrowserContextOptions;
  actionTimeout: number;
  navigationTimeout: number;
}

let activeDefaults: Readonly<RunnerContextDefaults> | undefined;

/** The runner owns one hook/test scope per worker; ordinary library use has no active defaults. */
export function installRunnerContextDefaults(defaults: RunnerContextDefaults): () => void {
  if (activeDefaults) throw failure('ProtocolError', 'runner.integration', 'a runner context-default scope is already active');
  validateTimeout(defaults.actionTimeout, 'runner.actionTimeout');
  validateTimeout(defaults.navigationTimeout, 'runner.navigationTimeout');
  const installed = Object.freeze({ ...defaults, contextOptions: Object.freeze({ ...defaults.contextOptions }) });
  activeDefaults = installed;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (activeDefaults !== installed) throw failure('ProtocolError', 'runner.integration', 'runner context-default ownership changed before teardown');
    activeDefaults = undefined;
  };
}

/** Capture at invocation so asynchronous creation keeps the configuration that started it. */
export function currentRunnerContextDefaults(): Readonly<RunnerContextDefaults> | undefined {
  return activeDefaults;
}

/** Request contexts inherit only their supported overlap with browser configuration. */
export function prepareRunnerRequestContextOptions(options: APIRequestContextOptions, defaults: Readonly<RunnerContextDefaults> | undefined): APIRequestContextOptions {
  const capturedOptions = { ...options };
  if (!defaults) return capturedOptions;
  const inheritedOptions: APIRequestContextOptions = {};
  if (!Object.hasOwn(capturedOptions, 'baseURL') && defaults.contextOptions.baseURL !== undefined) inheritedOptions.baseURL = defaults.contextOptions.baseURL;
  if (!Object.hasOwn(capturedOptions, 'storageState') && defaults.contextOptions.storageState !== undefined) inheritedOptions.storageState = defaults.contextOptions.storageState;
  if (!Object.hasOwn(capturedOptions, 'userAgent') && defaults.contextOptions.userAgent !== undefined) inheritedOptions.userAgent = defaults.contextOptions.userAgent;
  if (!Object.hasOwn(capturedOptions, 'ignoreHTTPSErrors') && defaults.contextOptions.ignoreHTTPSErrors !== undefined) inheritedOptions.ignoreHTTPSErrors = defaults.contextOptions.ignoreHTTPSErrors;
  return { ...inheritedOptions, ...capturedOptions, timeout: capturedOptions.timeout === undefined ? defaults.actionTimeout : capturedOptions.timeout };
}
