import { instrumentTraceMethods, type TraceOwner } from './trace-hooks.js';
import { readFile } from 'node:fs/promises';
import type { EngineClient } from './client.js';
import { failure } from './errors.js';
import { validateOptions } from './validation.js';

export type InitScript<Argument = void> = string | ((argument: Argument) => unknown) | { path?: string; content?: string };
export interface Disposable { dispose(): Promise<void>; [Symbol.asyncDispose](): Promise<void> }

/** Match the pinned init-script JSON argument contract, which differs from evaluate's value codec. */
export async function prepareInitScript(method: string, script: unknown, argument?: unknown): Promise<string> {
  let source: string;
  if (typeof script === 'function') {
    let serialized: string | undefined;
    try { serialized = argument === undefined ? 'undefined' : JSON.stringify(argument); }
    catch (error) { throw failure('InvalidArgumentError', method, `init script argument must be JSON serializable: ${String(error)}`); }
    source = `(${script.toString()})(${serialized})`;
  } else {
    if (argument !== undefined) throw failure('InvalidArgumentError', method, 'a script argument requires a function');
    if (typeof script === 'string') source = script;
    else {
      validateOptions(method, script as object, ['path', 'content']);
      const options = script as { path?: unknown; content?: unknown };
      if (options.content !== undefined) {
        if (typeof options.content !== 'string') throw failure('InvalidArgumentError', method, 'content must be a string');
        source = options.content;
      } else if (options.path !== undefined) {
        if (typeof options.path !== 'string') throw failure('InvalidArgumentError', method, 'path must be a string');
        source = `${await readFile(options.path, 'utf8')}\n//# sourceURL=${options.path.replace(/\n/g, '')}`;
      } else throw failure('InvalidArgumentError', method, 'provide a function, string, content or path');
    }
  }
  if (source.length > 1_000_000) throw failure('ResourceLimitError', method, 'init script exceeds 1000000 UTF-16 code units');
  // The reference scopes each registration independently. JSON inside JSON preserves lone surrogates through Rust.
  return JSON.stringify(`(() => {\n${source}\n})();`);
}

export class InitScriptRegistration implements Disposable {
  static { instrumentTraceMethods(this.prototype, 'Disposable', registration => registration.traceOwner?.(), { dispose: {} }); }
  private disposal: Promise<void> | undefined;
  constructor(private readonly client: EngineClient, private readonly identifier: string, private readonly traceOwner?: () => TraceOwner | undefined) {}
  dispose(): Promise<void> {
    return this.disposal ??= this.client.request('initScript.dispose', { script: this.identifier }).then(() => {}, error => {
      if (!['TargetClosedError', 'BrowserDisconnectedError'].includes(error?.name)) throw error;
    });
  }
  [Symbol.asyncDispose](): Promise<void> { return this.dispose(); }
}
