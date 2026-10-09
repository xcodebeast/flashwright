import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Run executable protocol fixtures with the exact runtime driving the test. */
export function createRuntimeFixture(script) {
  const directory = mkdtempSync(join(tmpdir(), 'flashwright-protocol-fixture-'));
  const executable = join(directory, 'driver');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve(script))} "$@"\n`, { mode: 0o700 });
  process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
  return executable;
}
