/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Flashwright: Node's compile cache is created right after a module is compiled, so it only holds
// the functions V8 compiles eagerly. Playwright's bundles run almost all of their code from lazily
// compiled functions, which every runner and worker process then compiles again. This compiles
// the large bundles of playwright and playwright-core with a V8 code cache that is created when
// the process exits, after that code has run, and reused by later processes of the same kind.
// Keep this module free of heavy imports: it is loaded before everything else.

import crypto from 'crypto';
import fs from 'fs';
import Module from 'module';
import os from 'os';
import path from 'path';
import vm from 'vm';

type Role = 'runner' | 'worker';

const minimumSize = 32 * 1024;
const pending: { script: vm.Script, cacheFile: string, staleFiles: string[] }[] = [];
let installed = false;

export function installCodeCache(role: Role) {
  if (installed || process.env.NODE_DISABLE_COMPILE_CACHE || process.env.FLASHWRIGHT_DISABLE_CODE_CACHE || process.env.NODE_V8_COVERAGE)
    return;
  const importModuleDynamically = (vm as any).constants?.USE_MAIN_CONTEXT_DEFAULT_LOADER;
  const originalCompile = (Module.prototype as any)._compile;
  if (!importModuleDynamically || typeof originalCompile !== 'function')
    return;
  installed = true;
  silenceDefaultLoaderWarning(importModuleDynamically);

  const roots = packageLibDirs();
  const cacheDir = path.join(os.tmpdir(), 'flashwright-code-cache', `${process.version}-${process.arch}`, role);

  (Module.prototype as any)._compile = function(this: any, content: string, filename: string, format?: string) {
    if (format === 'module' || typeof content !== 'string' || content.length < minimumSize || content.startsWith('#!') || !roots.some(root => filename.startsWith(root)))
      return originalCompile.apply(this, arguments);
    let compiled: Function;
    try {
      compiled = compileWithCache(content, filename, cacheDir, importModuleDynamically);
    } catch {
      return originalCompile.apply(this, arguments);
    }
    return compiled.call(this.exports, this.exports, makeRequireFunction(this), this, filename, path.dirname(filename));
  };
  process.once('exit', writeCodeCaches);
}

// Scripts compiled here keep using Node's default loader for import(), which Node reports with a
// one-time "experimental feature" warning on the first such import. Users never opted into
// anything, so trigger that one-time warning here and drop it.
function silenceDefaultLoaderWarning(importModuleDynamically: any) {
  const emitWarning = process.emitWarning;
  process.emitWarning = function(this: any, warning: string | Error, ...args: any[]) {
    if (typeof warning === 'string' && warning.startsWith('vm.USE_MAIN_CONTEXT_DEFAULT_LOADER'))
      return;
    return (emitWarning as any).call(this, warning, ...args);
  } as typeof process.emitWarning;
  try {
    new vm.Script('import("node:path").catch(() => {})', { importModuleDynamically }).runInThisContext();
  } catch {
  } finally {
    process.emitWarning = emitWarning;
  }
}

function packageLibDirs(): string[] {
  const dirs = [path.join(path.dirname(__dirname), 'lib') + path.sep];
  try {
    dirs.push(path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib') + path.sep);
  } catch {
  }
  return dirs;
}

function compileWithCache(content: string, filename: string, cacheDir: string, importModuleDynamically: any): Function {
  const stat = fs.statSync(filename);
  // One entry per installed file; a changed file gets a new version and replaces the old one.
  const fileKey = crypto.createHash('sha1').update(filename).digest('hex').slice(0, 16);
  const versionKey = crypto.createHash('sha1').update(`${stat.size}:${stat.mtimeMs}:${content.length}`).digest('hex').slice(0, 16);
  const cacheFile = path.join(cacheDir, `${fileKey}-${versionKey}`);
  let cachedData: Buffer | undefined;
  try {
    cachedData = fs.readFileSync(cacheFile);
  } catch {
  }
  const script = new vm.Script((Module as any).wrap(content), { filename, cachedData, importModuleDynamically });
  if (!cachedData || script.cachedDataRejected)
    pending.push({ script, cacheFile, staleFiles: staleCacheFiles(cacheDir, fileKey, cacheFile) });
  return script.runInThisContext({ displayErrors: true });
}

function staleCacheFiles(cacheDir: string, fileKey: string, cacheFile: string): string[] {
  try {
    return fs.readdirSync(cacheDir).filter(name => name.startsWith(fileKey + '-')).map(name => path.join(cacheDir, name)).filter(file => file !== cacheFile);
  } catch {
    return [];
  }
}

// Mirrors the require() that Node gives CommonJS modules.
function makeRequireFunction(mod: any) {
  const require: any = (id: string) => mod.require(id);
  const resolve: any = (request: string, options?: { paths?: string[] }) => (Module as any)._resolveFilename(request, mod, false, options);
  resolve.paths = (request: string) => (Module as any)._resolveLookupPaths(request, mod);
  require.resolve = resolve;
  require.main = process.mainModule;
  require.extensions = (Module as any)._extensions;
  require.cache = (Module as any)._cache;
  return require;
}

function writeCodeCaches() {
  for (const { script, cacheFile, staleFiles } of pending.splice(0)) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      // Write a sibling file and rename it, so that concurrent processes never read a partial cache.
      const temporary = `${cacheFile}.${process.pid}`;
      fs.writeFileSync(temporary, script.createCachedData());
      fs.renameSync(temporary, cacheFile);
      for (const file of staleFiles)
        fs.rmSync(file, { force: true });
    } catch {
    }
  }
}

// Worker processes load this module as the first dependency of their entry script.
if (/workerProcessEntry\.js$/.test(process.argv[1] || ''))
  installCodeCache('worker');
