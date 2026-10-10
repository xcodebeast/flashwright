import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Guard the same private runner instance that owns Flashwright's assertions. */
export function forbidUpstreamBrowserBackend() {
  const require = createRequire(import.meta.url);
  const runnerRequire = createRequire(require.resolve('@flashwright/test'));
  const runnerDirectory = dirname(runnerRequire.resolve('@flashwright/runner/package.json'));
  const upstream = runnerRequire(join(runnerDirectory, 'dist/upstream/test.js'));
  for (const browser of [upstream.chromium, upstream.firefox, upstream.webkit]) {
    for (const method of ['launch', 'launchPersistentContext', 'connect', 'connectOverCDP']) {
      browser[method] = async () => { throw new Error('Forbidden upstream browser backend entered'); };
    }
  }
  upstream.request.newContext = async () => { throw new Error('Forbidden upstream request backend entered'); };
  return upstream;
}
