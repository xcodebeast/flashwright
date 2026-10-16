import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyLinuxLaunch } from '../benchmarks/cypress/linux-launch-contract.mjs';
import environmentPolicy from '../benchmarks/cypress/linux-environment-policy.cjs';
import titlePolicy from '../benchmarks/cypress/linux-title-policy.cjs';
const policy = JSON.parse(await readFile(new URL('../benchmarks/configurations/cypress-linux-launch-policy.json', import.meta.url), 'utf8'));
const output = '/fixture/output';
const make = () => {
  const proposed = structuredClone(policy);
  proposed.args = proposed.args.map(arg => arg.replace('__PORT__', '12345'));
  const browser = { process: 51, parent: 50, startTicks: '200', executable: '/fixture/chrome', profilePath: output + '/config/profile', cachePath: output + '/cache/profile',
    ancestry: [{ process: 51, parent: 50, startTicks: '200' }, { process: 50, parent: 49, startTicks: '100' }],
    environment: { XDG_SESSION_TYPE: 'x11', ELECTRON_OZONE_PLATFORM_HINT: 'x11', DISPLAY: ':190', HOME: output + '/home', XDG_CONFIG_HOME: output + '/config', XDG_CACHE_HOME: output + '/cache' },
    preferences: { 'Default/Preferences': { autofill: { profile_enabled: false, credit_card_enabled: false }, translate: { enabled: false } }, 'Local State': { browser: { command_line_flag_security_warnings_enabled: false, promotions_enabled: false } } },
    commandLineRepresentation: 'nul-separated-command-line', unavailablePreferenceFiles: [] };
  browser.environmentObservation = { mode: 'proc-selected-environment', selected: browser.environment };
  browser.observedCommandLine = [browser.executable, 'about:blank', ...proposed.args, `--user-data-dir=${browser.profilePath}`, `--disk-cache-dir=${browser.cachePath}`];
  browser.command = browser.observedCommandLine.join(' ');
  browser.rawCommandLineBase64 = Buffer.from(browser.observedCommandLine.join('\0') + '\0').toString('base64');
  return { report: { browserProcesses: [browser], browser: { executablePath: '/fixture/chrome' }, launch: { proposedLaunchOptions: proposed } },
    display: { displayEnvironment: structuredClone(browser.environment), status: 'passed', forcedKill: false, cleanupErrors: [], runnerExitCode: 0, displayExitCode: 0, remainingDisplayPaths: [], number: 190, displayLockOwner: 45, displayPid: 45, runnerPid: 50, screen: { width: 1280, height: 720, depth: 24 } } };
};
const verify = ({ report, display }) => verifyLinuxLaunch(report, display, output);
verify(make());
const title = make();
const titleBrowser = title.report.browserProcesses[0];
titleBrowser.commandLineRepresentation = 'space-joined-process-title';
titleBrowser.command = titlePolicy.titleArguments(titleBrowser.executable, title.report.launch.proposedLaunchOptions.args, titleBrowser.profilePath, titleBrowser.cachePath).join(' ');
titleBrowser.observedCommandLine = [titleBrowser.command];
titleBrowser.rawCommandLineBase64 = Buffer.from(titleBrowser.command + '\0\0').toString('base64');
function overwriteEnvironment(browser, overlap = 0) {
 const argStart=1000n, argEnd=argStart+BigInt(Buffer.byteLength(browser.command)-overlap);
 const ranges={argStart:String(argStart),argEnd:String(argEnd),envStart:String(argEnd),envEnd:String(argEnd+4096n)};
 const bytes=environmentPolicy.overwrittenBytes(ranges,browser.command);
 browser.environment=null;
 browser.environmentObservation={mode:'title-overwritten-proc-storage',selected:null,ranges,rawBase64:bytes.toString('base64'),liveBrowserEnvironmentObserved:false};
}
overwriteEnvironment(titleBrowser);
verify(title);
const overlap=structuredClone(title);overwriteEnvironment(overlap.report.browserProcesses[0],50);verify(overlap);
const absent = make();
absent.report.browserProcesses[0].unavailablePreferenceFiles = ['Default/Secure Preferences'];
absent.report.browserProcesses[0].preferences['Default/Secure Preferences'] = {};
verify(absent);
const updateRawVector = state => {
  const browser = state.report.browserProcesses[0];
  browser.rawCommandLineBase64 = Buffer.from(browser.observedCommandLine.join('\0') + '\0').toString('base64');
};
const mutations = [
  ['interior empty kernel argument', s => { s.report.browserProcesses[0].observedCommandLine.splice(3, 0, ''); updateRawVector(s); }],
  ['trailing empty kernel argument', s => { s.report.browserProcesses[0].observedCommandLine.push(''); updateRawVector(s); }],
  ['coherent extra kernel argument', s => { s.report.browserProcesses[0].observedCommandLine.splice(3, 0, '--extra'); updateRawVector(s); }],
  ['coherent missing kernel argument', s => { s.report.browserProcesses[0].observedCommandLine.splice(3, 1); updateRawVector(s); }],
  ['cleanup error', s => s.display.cleanupErrors.push('failed wait')],
  ['wrong raw bytes', s => s.report.browserProcesses[0].rawCommandLineBase64 = Buffer.from('altered\0').toString('base64')],
  ['extra actual argument', s => s.report.browserProcesses[0].observedCommandLine.push('--extra')],
  ['missing actual argument', s => s.report.browserProcesses[0].observedCommandLine.splice(5, 1)],
  ['foreign executable', s => s.report.browserProcesses[0].executable = '/other/chrome'],
  ['multiple browser roots', s => s.report.browserProcesses.push(structuredClone(s.report.browserProcesses[0]))],
  ['external profile', s => s.report.browserProcesses[0].profilePath = '/fixture/output-foreign/profile'],
  ['wrong display', s => s.report.browserProcesses[0].environment.DISPLAY = ':0'],
  ['external home', s => s.report.browserProcesses[0].environment.HOME = '/home/foreign'],
  ['foreign runner', s => s.display.runnerPid++],
  ['broken ancestry', s => s.report.browserProcesses[0].ancestry[0].parent++],
  ['missing start token', s => delete s.report.browserProcesses[0].ancestry[0].startTicks],
  ['stale command representation', s => s.report.browserProcesses[0].command += ' extra'],
  ['changed actual preference', s => s.report.browserProcesses[0].preferences['Default/Preferences'].autofill.profile_enabled = true],
  ['changed local state', s => s.report.browserProcesses[0].preferences['Local State'].browser.promotions_enabled = true],
  ['display lock mismatch', s => s.display.displayLockOwner++],
  ['display failure', s => s.display.displayExitCode = 1],
  ['runner failure', s => s.display.runnerExitCode = 7],
  ['forced cleanup', s => s.display.forcedKill = true],
  ['remaining display socket', s => s.display.remainingDisplayPaths.push('/tmp/.X11-unix/X190')],
  ['wrong screen', s => s.display.screen.width = 1],
];
for (const [name, mutate] of mutations) { const state = make(); mutate(state); assert.throws(() => verify(state), name); }
const malformedTitle = structuredClone(title);
malformedTitle.report.browserProcesses[0].rawCommandLineBase64 = Buffer.from(titleBrowser.command + '\0--extra\0').toString('base64');
assert.throws(() => verify(malformedTitle));
const titleMutations = [
  ['missing native headless switch', value => value.replace(' --ozone-platform=headless', '')],
  ['changed native screen', value => value.replace('800,600', '1280,720')],
  ['changed native angle', value => value.replace('swiftshader-webgl', 'gl')],
  ['additional native switch', value => value.replace(' about:blank', ' --extra about:blank')],
  ['duplicate native switch', value => value.replace(' --ozone-platform=headless', ' --ozone-platform=headless --ozone-platform=headless')],
  ['changed positional order', value => value.replace(' about:blank', '').replace(' --test-type', ' about:blank --test-type')],
];
for(const [name, change] of titleMutations) {
 const state=structuredClone(title);const b=state.report.browserProcesses[0];
 b.command=change(b.command);b.observedCommandLine=[b.command];b.rawCommandLineBase64=Buffer.from(b.command+'\0').toString('base64');
 assert.throws(()=>verify(state),name);
}
assert.deepEqual(titlePolicy.privatePaths(titleBrowser.observedCommandLine,true),[titleBrowser.profilePath,titleBrowser.cachePath]);
const vector=make().report.browserProcesses[0];assert.deepEqual(titlePolicy.privatePaths(vector.observedCommandLine,false),[vector.profilePath,vector.cachePath]);
assert.throws(()=>titlePolicy.privatePaths([titleBrowser.command+' extra'],true));
const environmentMutations = [
 ['missing environment observation', s => delete s.report.browserProcesses[0].environmentObservation],
 ['pretended live observation', s => s.report.browserProcesses[0].environmentObservation.liveBrowserEnvironmentObserved=true],
 ['fabricated selected environment', s => s.report.browserProcesses[0].environmentObservation.selected={}],
 ['empty raw environment', s => s.report.browserProcesses[0].environmentObservation.rawBase64=''],
 ['noncanonical base64', s => s.report.browserProcesses[0].environmentObservation.rawBase64+='\n'],
 ['wrong raw environment byte', s => {const o=s.report.browserProcesses[0].environmentObservation;const b=Buffer.from(o.rawBase64,'base64');b[b.length-1]=1;o.rawBase64=b.toString('base64');}],
 ['different memory length', s => s.report.browserProcesses[0].environmentObservation.ranges.envEnd='99999'],
 ['nonadjacent memory', s => s.report.browserProcesses[0].environmentObservation.ranges.argEnd='1001'],
 ['zero address', s => s.report.browserProcesses[0].environmentObservation.ranges.argStart='0'],
 ['oversized memory', s => s.report.browserProcesses[0].environmentObservation.ranges.envEnd='999999999999'],
 ['false environment class', s => s.report.browserProcesses[0].environmentObservation.mode='proc-selected-environment'],
 ['wrong runner X11', s => s.display.displayEnvironment.XDG_SESSION_TYPE='wayland'],
 ['wrong runner home', s => s.display.displayEnvironment.HOME='/home/foreign'],
 ['missing runner environment', s => delete s.display.displayEnvironment],
 ['hidden browser map', s => s.report.browserProcesses[0].environment={}],
];
for(const [name,mutate] of environmentMutations){const state=structuredClone(overlap);mutate(state);assert.throws(()=>verify(state),name);}
// Exercise stat field indexing and the collector against a synthetic proc record.
const b=overlap.report.browserProcesses[0];const f=Array(50).fill('0');
['argStart','argEnd','envStart','envEnd'].forEach((k,i)=>f[45+i]=b.environmentObservation.ranges[k]);
assert.deepEqual(environmentPolicy.observeEnvironment(Buffer.from(b.environmentObservation.rawBase64,'base64'),'51 (chrome with ) bracket) '+f.join(' '),b.command,true),b.environmentObservation);
console.log(JSON.stringify({ status: 'passed', positive: 4, negative: [...mutations.map(([name]) => name), 'hidden data after title', ...titleMutations.map(([name])=>name), 'extra title suffix', ...environmentMutations.map(([name])=>name)], scope: 'Synthetic launch rejection controls; no browser or performance evidence.' }));

for (const isTitle of [false, true]) {
  const profile = '/fixture/output with spaces/config/profile';
  const cache = '/fixture/output with spaces/cache/profile';
  const args = titlePolicy.titleArguments('/fixture/chrome', ['--test-type'], profile, cache);
  const observed = isTitle ? [args.join(' ')] : ['/fixture/chrome', 'about:blank', '--test-type', `--user-data-dir=${profile}`, `--disk-cache-dir=${cache}`];
  assert.deepEqual(titlePolicy.privatePaths(observed, isTitle), [profile, cache]);
}
assert.throws(() => titlePolicy.privatePaths([titleBrowser.command.replace('--disk-cache-dir=', '--disk-cache-dir=/ambiguous --disk-cache-dir=')], true));
assert.throws(() => titlePolicy.privatePaths(['/chrome', '--user-data-dir=relative', '--disk-cache-dir=/cache'], false));
console.log('Path extraction: spaces accepted in both representations; ambiguous title and relative path rejected.');
