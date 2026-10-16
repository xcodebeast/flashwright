const assert = require('node:assert/strict');
const { readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { observeEnvironment } = require('./linux-environment-policy.cjs');
const { privatePaths } = require('./linux-title-policy.cjs');
function identity(pid) {
  const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { process: Number(pid), parent: Number(fields[1]), startTicks: fields[19] };
}
function recordOwnedBrowserProcesses() {
  const owner = Number(process.env.FLASHWRIGHT_CYPRESS_OWNER);
  assert.ok(Number.isSafeInteger(owner) && owner > 0);
  const ownerIdentity = identity(owner);
  const processes = [];
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try { processes.push(identity(pid)); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  const byPid = new Map(processes.map(item => [item.process, item]));
  const descendants = new Set([owner]);
  let changed;
  do {
    changed = false;
    for (const item of processes) if (descendants.has(item.parent) && !descendants.has(item.process)) { descendants.add(item.process); changed = true; }
  } while (changed);
  const browser = realpathSync(process.env.FLASHWRIGHT_BROWSER_PATH);
  const found = [];
  for (const item of processes.filter(item => item.process !== owner && descendants.has(item.process))) {
    let executable;
    try { executable = readlinkSync(`/proc/${item.process}/exe`); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
    if (executable !== browser) continue;
    const bytes = readFileSync(`/proc/${item.process}/cmdline`);
    writeFileSync(join(dirname(process.env.FLASHWRIGHT_CYPRESS_PROCESSES), `raw-browser-command-${item.process}.json`), JSON.stringify({ ...item, executable, rawCommandLineBase64: bytes.toString('base64') }, null, 2) + '\n', { flag: 'wx' });
    assert.equal(bytes.at(-1), 0);
    const segments = bytes.toString('utf8').split('\0');
    const isTitle = segments[0].startsWith(browser + ' ');
    if (isTitle) assert.ok(segments.slice(1).every(value => value === ''), 'Unexpected data after process title');
    const observedCommandLine = isTitle ? [segments[0]] : segments.slice(0, -1);
    const command = observedCommandLine.join(' ');
    if (/(?:^| )--type=/.test(command)) continue;
    assert.ok(command.startsWith(browser + ' '));
    // Retain the complete title without inventing original argument boundaries.
    // Only the two source-defined final paths are extracted; the verifier compares
    // the entire observation to the proposed policy plus those exact suffixes.
    const [profile, cache] = privatePaths(observedCommandLine, isTitle);
    const profiles = [profile], caches = [cache];
    const commandLineRepresentation = isTitle ? 'space-joined-process-title' : 'nul-separated-command-line';
    const ancestry = [];
    let current = item;
    while (current.process !== owner) {
      assert.ok(current && ancestry.length < processes.length);
      ancestry.push(current);
      assert.deepEqual(identity(current.process), current);
      current = byPid.get(current.parent);
      assert.ok(current, 'Missing original owner ancestry');
    }
    assert.deepEqual(identity(owner), ownerIdentity);
    ancestry.push(ownerIdentity);
    const environmentObservation = observeEnvironment(
      readFileSync(`/proc/${item.process}/environ`),
      readFileSync(`/proc/${item.process}/stat`, 'utf8'), command, isTitle);
    const environment = environmentObservation.selected;
    const preferences = {}, unavailablePreferenceFiles = [];
    for (const name of ['Default/Preferences', 'Default/Secure Preferences', 'Local State']) {
      try { preferences[name] = JSON.parse(readFileSync(join(profiles[0], name), 'utf8')); }
      catch (error) {
        if (name !== 'Default/Secure Preferences' || error.code !== 'ENOENT') throw error;
        preferences[name] = {};
        unavailablePreferenceFiles.push(name);
      }
    }
    assert.deepEqual(identity(item.process), item);
    found.push({ ...item, executable, observedCommandLine, rawCommandLineBase64: bytes.toString('base64'), command, commandLineRepresentation, ancestry, environment, environmentObservation, preferences, unavailablePreferenceFiles, profilePath: profiles[0], cachePath: caches[0] });
  }
  return found;
}
module.exports = { identity, recordOwnedBrowserProcesses };
