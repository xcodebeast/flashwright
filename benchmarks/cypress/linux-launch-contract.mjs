import assert from 'node:assert/strict';
import { join, relative, isAbsolute } from 'node:path';
import environmentPolicy from './linux-environment-policy.cjs';
import titlePolicy from './linux-title-policy.cjs';
export function verifyLinuxLaunch(report, display, output) {
  assert.equal(display.status, 'passed');
  assert.equal(display.forcedKill, false);
  assert.deepEqual(display.cleanupErrors, []);
  assert.equal(display.runnerExitCode, 0);
  assert.equal(display.displayExitCode, 0);
  assert.deepEqual(display.remainingDisplayPaths, []);
  assert.ok(display.number >= 190 && display.number < 290);
  assert.equal(display.displayLockOwner, display.displayPid);
  assert.deepEqual(display.screen, { width: 1280, height: 720, depth: 24 });
  assert.equal(report.browserProcesses.length, 1);
  const browser = report.browserProcesses[0];
  assert.equal(browser.executable, report.browser.executablePath);
  const expected = [browser.executable, 'about:blank', ...report.launch.proposedLaunchOptions.args,
    `--user-data-dir=${browser.profilePath}`, `--disk-cache-dir=${browser.cachePath}`];
  const bytes = Buffer.from(browser.rawCommandLineBase64, 'base64');
  assert.ok(bytes.toString('base64') === browser.rawCommandLineBase64, 'Noncanonical command encoding');
  assert.equal(bytes.at(-1), 0);
  if (browser.commandLineRepresentation === 'nul-separated-command-line') {
    assert.ok(bytes.equals(Buffer.from(expected.join('\0') + '\0')), 'Unexpected command bytes');
    assert.deepEqual(browser.observedCommandLine, expected);
  }
  else {
    assert.equal(browser.commandLineRepresentation, 'space-joined-process-title');
    const title = titlePolicy.titleArguments(browser.executable, report.launch.proposedLaunchOptions.args, browser.profilePath, browser.cachePath).join(' ');
    assert.deepEqual(browser.observedCommandLine, [title]);
    const segments = bytes.toString('utf8').split('\0');
    assert.equal(segments[0], title);
    assert.ok(segments.slice(1).every(value => value === ''), 'Unexpected data after process title');
    // Exact title equality cannot establish original kernel argument boundaries.
  }
  assert.equal(browser.command, browser.observedCommandLine.join(' '));
  assert.ok(Array.isArray(browser.unavailablePreferenceFiles));
  assert.ok(browser.unavailablePreferenceFiles.length <= 1);
  for (const name of browser.unavailablePreferenceFiles) {
    assert.equal(name, 'Default/Secure Preferences');
    assert.deepEqual(browser.preferences[name], {});
  }
  const privatePath = path => {
    const suffix = relative(output, path);
    assert.ok(suffix && suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix), path);
  };
  privatePath(browser.profilePath);
  privatePath(browser.cachePath);
  const expectedEnvironment = { XDG_SESSION_TYPE: 'x11', ELECTRON_OZONE_PLATFORM_HINT: 'x11', DISPLAY: `:${display.number}`, HOME: join(output, 'home'),
    XDG_CONFIG_HOME: join(output, 'config'), XDG_CACHE_HOME: join(output, 'cache') };
  assert.deepEqual(display.displayEnvironment, expectedEnvironment);
  environmentPolicy.verifyEnvironment(browser.environmentObservation, browser.command, browser.commandLineRepresentation === 'space-joined-process-title', expectedEnvironment);
  assert.deepEqual(browser.environment, browser.environmentObservation.selected);
  assert.ok(browser.ancestry.length >= 2);
  assert.equal(browser.ancestry[0].process, browser.process);
  assert.equal(browser.ancestry.at(-1).process, display.runnerPid);
  for (let i = 0; i < browser.ancestry.length; i++) {
    const entry = browser.ancestry[i];
    assert.match(entry.startTicks, /^\d+$/);
    assert.ok(Number.isSafeInteger(entry.process) && entry.process > 0);
    if (i + 1 < browser.ancestry.length) assert.equal(entry.parent, browser.ancestry[i + 1].process);
  }
  const defaults = browser.preferences['Default/Preferences'];
  const local = browser.preferences['Local State'];
  assert.equal(defaults.autofill.profile_enabled, false);
  assert.equal(defaults.autofill.credit_card_enabled, false);
  assert.equal(defaults.translate.enabled, false);
  assert.equal(local.browser.command_line_flag_security_warnings_enabled, false);
  assert.equal(local.browser.promotions_enabled, false);
}
