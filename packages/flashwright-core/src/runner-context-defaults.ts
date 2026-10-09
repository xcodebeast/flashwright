import type { BrowserContextOptions } from './index.js';
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
