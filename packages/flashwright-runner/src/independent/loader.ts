import { registerHooks } from 'node:module';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let registered = false;
/** Keep Node's native TypeScript loader, adding the relative resolution used by test sources. */
export function registerIndependentLoader(): void {
  if (registered || process.versions.bun) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (!['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT'].includes((error as NodeJS.ErrnoException).code ?? '') ||
            !context.parentURL?.startsWith('file:') || !specifier.startsWith('.')) throw error;
        const url = new URL(specifier, context.parentURL);
        if (url.search || url.hash) throw error;
        const candidates = /\.[cm]?js$/.test(url.pathname)
          ? [url.href.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts')]
          : /\.[^/]+$/.test(url.pathname) ? []
          : ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '/index.ts', '/index.js'].map(suffix => url.href + suffix);
        for (const candidate of candidates) {
          try { if (!statSync(fileURLToPath(candidate)).isFile()) continue; }
          catch (cause) { if (['ENOENT', 'ENOTDIR'].includes((cause as NodeJS.ErrnoException).code ?? '')) continue; throw cause; }
          return nextResolve(candidate, context);
        }
        throw error;
      }
    },
  });
}
