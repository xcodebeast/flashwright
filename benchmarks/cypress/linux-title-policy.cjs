const assert = require('node:assert/strict');
// Pinned Linux full Chrome appends these headless switches and serializes
// switches before positional arguments when rewriting its process title.
const nativeSwitches = Object.freeze(['--ozone-platform=headless', '--ozone-override-screen-size=800,600', '--use-angle=swiftshader-webgl']);
function titleArguments(executable, proposed, profile, cache) {
  return [executable, ...proposed, `--user-data-dir=${profile}`, `--disk-cache-dir=${cache}`, ...nativeSwitches, 'about:blank'];
}
function privatePaths(observed, isTitle) {
  let values;
  if (isTitle) {
    assert.equal(observed.length, 1);
    const tail = ' ' + [...nativeSwitches, 'about:blank'].join(' ');
    assert.ok(observed[0].endsWith(tail), 'Expected exact native title suffix');
    const command = observed[0].slice(0, -tail.length);
    // A rewritten title loses argument boundaries. Accept spaces in paths, but
    // refuse ambiguous delimiter text rather than guessing original arguments.
    const profile = command.split(' --user-data-dir=');
    assert.equal(profile.length, 2, 'Ambiguous profile delimiter in process title');
    const cache = profile[1].split(' --disk-cache-dir=');
    assert.equal(cache.length, 2, 'Ambiguous cache delimiter in process title');
    values = cache;
  } else {
    assert.ok(observed.length >= 3);
    const profile = observed.at(-2), cache = observed.at(-1);
    assert.ok(profile.startsWith('--user-data-dir='));
    assert.ok(cache.startsWith('--disk-cache-dir='));
    values = [profile.slice('--user-data-dir='.length), cache.slice('--disk-cache-dir='.length)];
  }
  for (const value of values) assert.ok(value.startsWith('/') && !value.includes('\0'), 'Expected absolute private path');
  return values;
}
module.exports = { nativeSwitches, titleArguments, privatePaths };
