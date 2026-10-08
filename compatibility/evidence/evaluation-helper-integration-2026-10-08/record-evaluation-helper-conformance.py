import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    with Path(path).open('x') as output:
        output.write(json.dumps(value, indent=2) + '\n')


linux_output = Path('.cache/linux-core-026')
linux_reports = list((linux_output / 'evidence').glob('core-*/report.json'))
assert len(linux_reports) == 1 and read(linux_reports[0])['status'] == 'passed'
shutil.copytree(linux_output / 'evidence', 'compatibility/evidence', dirs_exist_ok=True)
linux_path = Path('compatibility/evidence') / linux_reports[0].parent.name / 'report.json'
Path('.cache/evaluation-helper-linux-core-path.txt').write_text(str(linux_path) + '\n')
core_paths = [Path('.cache/resident-core-evaluation-helper-' + label + '-path.txt').read_text().strip() for label in ['headless-on', 'headless-off', 'full-chrome-on']]
core_paths.append(str(linux_path))
sources = read(core_paths[0])['sources']
for path, expected in sources.items():
    assert digest(path) == expected, path
core = []
registry = []
for path in core_paths:
    report = read(path)
    assert report['status'] == 'passed' and len(report['checks']) == 26 and report['sources'] == sources
    assert not report['sourceChangedDuringVerification'] and not report['browserChangedDuringVerification']
    for check in report['checks']:
        assert check['code'] == 0 and digest(Path(path).parent / check['log']) == check['logSha256']
    binary = linux_output / 'flashwright-driver-linux-x64' if report['platform'] == 'linux' else Path('target/release/flashwright-driver')
    assert digest(binary) == report['driverSha256']
    core.append({'path': path, 'sha256': digest(path), 'checks': len(report['checks']), 'logsVerified': True, 'driverSha256': report['driverSha256'], 'browser': report['browser'], 'configuration': report['engineConfiguration'], 'environmentClass': report['environmentClass']})
    log = (Path(path).parent / report['checks'][19]['log']).read_text()
    registry_path = Path(re.findall(r'Resident registry evidence: (.+)', log)[-1])
    case_report = read(registry_path)
    assert case_report['sources'] == sources and len(case_report['cases']) == 57
    registry.append({'path': str(registry_path), 'sha256': digest(registry_path), 'cases': len(case_report['cases'])})
    if report['platform'] == 'linux':
        artifacts = Path(path).parent / 'artifacts'
        artifacts.mkdir()
        for source in (linux_output / 'evidence').glob('*.json'):
            shutil.copy2(source, artifacts / source.name)

node22_log = Path('compatibility/evidence/evaluation-helper-node22-2026-10-08.txt')
node22_text = node22_log.read_text()
assert 'Ran 26 tests' in node22_text and '\nOK\n' in node22_text
assert 'Real Chromium library smoke passed' in node22_text
node22_registry = Path(re.findall(r'Resident registry evidence: (.+)', node22_text)[-1])
assert read(node22_registry)['sources'] == sources and len(read(node22_registry)['cases']) == 57
exploration = Path('compatibility/evidence/evaluation-helper-integration-2026-10-08')
exploration.mkdir()
for source in [
    '.cache/evaluation-helper-build-001.log', '.cache/evaluation-helper-library-001.log',
    '.cache/evaluation-helper-library-002.log', '.cache/evaluation-helper-lifecycle-001.log',
    '.cache/evaluation-helper-clippy-001.log', '.cache/evaluation-helper-release-001.log',
    '.cache/verify-evaluation-helper.sh', '.cache/run-evaluation-helper-profiles.sh',
    '.cache/record-evaluation-helper-conformance.py',
]:
    shutil.copy2(source, exploration / Path(source).name)
save(exploration / 'report.json', {
    'sources': sources,
    'initialFixtureFailure': 'The first expanded library run failed in the Playwright reference because the Unicode source test expected a string without the space present in its input. The expected literal was corrected. Production code did not change for this failure. Both engines then passed; the later full suite also includes a pending evaluation rejected on page closure and a surviving replacement page.',
    'tests': ['Four Rust realm identity/lifetime/capacity regressions', 'Concurrent first evaluation on four fresh documents, same-document navigation, Unicode source and private globals', 'Same-page evaluations remain concurrent while one awaits a promise', 'User callback that navigates is never replayed in the successor', 'document.open preserves a usable main world', 'Page closure rejects a pending callback without breaking a replacement page', 'Fresh per-call value codec prevents old codec error identities from misclassifying later user exceptions', 'Paused real browser proves a timed-out first caller cannot own shared setup or dispatch its expired callback; another caller survives'],
    'files': {path.name: digest(path) for path in exploration.iterdir()},
})

resources = []
for name in subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', 'compatibility/evidence/resources'], text=True).splitlines():
    report = read(name)
    assert not report['timedOut'] and not report['interrupted'] and not report['cleanupSignals'] and not report['remainingObservedProcesses'], name
    resources.append({'path': name, 'sha256': digest(name), 'exitCode': report['exitCode']})
processes = [line for line in subprocess.check_output(['ps', '-axo', 'pid=,comm='], text=True).splitlines() if 'flashwright-driver' in line]
profiles = list(Path(tempfile.gettempdir()).glob('flashwright-*'))
assert not processes and not profiles, (processes, profiles)
containers = subprocess.check_output(['docker', 'ps', '--format', '{{.Names}}'], text=True).splitlines()
assert len(containers) == 8 and all(name.startswith('tairox-') for name in containers), containers
cleanup_path = 'compatibility/evidence/evaluation-helper-cleanup-2026-10-08.json'
save(cleanup_path, {'reports': resources, 'rootReports': len(resources), 'remainingDriverProcesses': processes, 'remainingProfiles': [], 'unrelatedContainersPreserved': containers, 'scope': 'Expected failure fixtures and the initial reference fixture typo can exit nonzero. No watchdog timeout, forced cleanup, remaining owned process or profile was found.'})
plan = 'compatibility/evidence/evaluation-helper-profile-plan-2026-10-08.json'
assert read(plan)['driverSha256'] == core[0]['driverSha256']
checkpoint_path = 'compatibility/evidence/evaluation-helper-checkpoint-2026-10-08.json'
save(checkpoint_path, {
    'status': 'Private document-owned evaluation helpers pass full development conformance. Ordinary performance comparisons remain pending.',
    'sources': sources, 'sourceCount': len(sources), 'coreEvidence': core,
    'totalCoreGroups': sum(item['checks'] for item in core), 'registryEvidence': registry,
    'node22': {'log': str(node22_log), 'logSha256': digest(node22_log), 'registry': str(node22_registry), 'registrySha256': digest(node22_registry), 'scope': 'Library/value/context tests, assertion differential, 26 lifecycle/protocol cases and 57 registry cases on macOS full Chromium.'},
    'change': 'Prepare private evaluation code once per main-world unique identity, share its document-owned reply across callers, use a new value codec for each callback, and pass the helper as an object argument to a callback pinned by uniqueContextId. No callback replay or global helper property. Caller cancellation during shared setup never terminates application JavaScript. At most 1024 live main-world contexts are tracked per page session.',
    'diagnostics': {'path': str(exploration / 'report.json'), 'sha256': digest(exploration / 'report.json')},
    'plan': {'path': plan, 'sha256': digest(plan)},
    'precedingPerformanceCheckpoint': 'compatibility/evidence/resident-indexed-performance-checkpoint-2026-10-08.json',
    'cleanup': {'path': cleanup_path, 'sha256': digest(cleanup_path)},
    'remaining': ['Run and independently verify the predeclared default-off and opt-in-on ordinary Playwright comparisons; retain all attempts.', 'Record instrumented protocol attribution separately from ordinary timing.', 'Continue unfinished M2 APIs, runner/artifacts, M3 transport, native Linux, contention, installation and release gates.'],
    'scope': 'Development conformance on native macOS arm64 Node24 headless shell on/off and full Chromium on, Linux x64 Node24 under local amd64 emulation, and macOS Node22 focused coverage. Linux timings are not native performance evidence.',
})
print(checkpoint_path, len(sources), core[0]['driverSha256'])
