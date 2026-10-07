import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

/** Retain the selected executable, including a distribution label separate from its version. */
export async function identifyBrowser(path) {
  const executablePath = resolve(path);
  const versionOutput = execFileSync(executablePath, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
  const version = versionOutput.match(/\b\d+\.\d+\.\d+\.\d+\b/)?.[0];
  assert.ok(version, `Cannot identify browser version: ${versionOutput}`);
  return {
    executablePath,
    sha256: createHash('sha256').update(await readFile(executablePath)).digest('hex'),
    version,
    versionOutput,
    distribution: basename(executablePath) === 'chrome-headless-shell' ? 'chromium-headless-shell' : 'full-chromium',
  };
}

/** A version match alone cannot authorize another executable or browser distribution. */
export function requireVerifiedBrowser(verification, browser) {
  assert.ok(verification.browser, 'Reverify the selected browser: this core report has no executable identity');
  assert.equal(verification.browserChangedDuringVerification, false, 'Browser changed during core verification');
  assert.equal(verification.browser.executablePath, browser.executablePath ?? browser.path, 'Reverify the selected browser path before timing');
  assert.equal(verification.browser.sha256, browser.sha256, 'Reverify the selected browser executable before timing');
  assert.equal(verification.browser.version, browser.version, 'Reverify the selected browser version before timing');
  assert.equal(verification.browser.distribution, browser.distribution, 'Reverify the selected browser distribution before timing');
}
