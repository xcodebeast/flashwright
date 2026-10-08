from pathlib import Path
import datetime
import hashlib
import json
import re
import shutil
import subprocess
import tempfile


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


destination = Path('compatibility/evidence/output-limits-integration-2026-10-08')
checkpoint = Path('compatibility/evidence/output-limits-checkpoint-2026-10-08.json')
native_paths = [Path(Path(f'.cache/resident-core-output-limits-{label}-path.txt').read_text().strip()) for label in ['full-chrome-on', 'headless-off']]
sources = read(native_paths[0])['sources']
assert len(sources) == 170
for name, expected in sources.items():
    assert digest(name) == expected, name
native_driver = Path('.cache/output-limits-002/flashwright-driver')
core = []
for path in native_paths:
    report = read(path)
    assert report['status'] == 'passed' and len(report['checks']) == 27
    assert report['sources'] == sources and not report['sourceChangedDuringVerification'] and not report['browserChangedDuringVerification']
    assert report['driverSha256'] == digest(native_driver)
    for check in report['checks']:
        assert check['code'] == 0 and digest(path.parent / check['log']) == check['logSha256']
    lifecycle = (path.parent / report['checks'][13]['log']).read_text()
    for count in [29, 10, 6]:
        assert f'Ran {count} tests' in lifecycle
    assert lifecycle.count('\nOK\n') == 3
    core.append({'path': str(path), 'sha256': digest(path), 'checks': 27, 'browser': report['browser'], 'configuration': report['engineConfiguration'], 'driverSha256': report['driverSha256']})

node22 = read('.cache/output-limits-node22/report.json')
assert node22['status'] == 'passed' and len(node22['checks']) == 8
assert node22['sources'] == sources and node22['driverSha256'] == digest(native_driver)
for check in node22['checks']:
    assert check['code'] == 0 and check['sha256'] == digest(Path('.cache/output-limits-node22') / check['log'])
linux_log = Path('.cache/linux-output-limits-036/run.log').read_text()
assert linux_log.count('Ran 10 tests') == 2 and 'Ran 6 tests' in linux_log
assert linux_log.count('\nOK\n') == 3
assert read('.cache/linux-output-limits-036/sources.json') == sources
assert not list(Path(tempfile.gettempdir()).glob('flashwright-chromium-*'))
for attempt in ['034', '035', '036']:
    assert not read(f'.cache/linux-output-limits-{attempt}/container-audit.json')['remainingProfiles']

destination.mkdir()
for sequence in ['001', '002']:
    shutil.copytree(f'.cache/output-limits-{sequence}', destination / f'native-{sequence}', ignore=shutil.ignore_patterns('flashwright-driver'))
shutil.copytree('.cache/output-limits-node22', destination / 'node22')
for attempt in ['034', '035', '036']:
    shutil.copytree(f'.cache/linux-output-limits-{attempt}', destination / f'linux-{attempt}', ignore=shutil.ignore_patterns('flashwright-driver-linux-x64'))
for name in ['verify-output-limits.sh', 'verify-output-limits-node22.mjs', 'linux-storage-core.sh', 'linux-output-limits-core.sh', 'linux-output-limits-focused.sh', 'record-output-limits.py', 'output-limits-cleanup-audit.json', 'update-output-limit-docs.py']:
    shutil.copy2(Path('.cache') / name, destination / name)
for path in Path('.cache').glob('output-limits-*.log'):
    shutil.copy2(path, destination / path.name)

resources = []
native_resources = subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', 'compatibility/evidence/resources'], text=True).splitlines()
for path in [*map(Path, native_resources), *destination.glob('linux-*/evidence/resources/*.json')]:
    report = read(path)
    assert report['remainingObservedProcesses'] == [], path
    observed = {}
    for sample in report['samples']:
        assert sample['concurrentRssBytes'] == sum(process['rssBytes'] for process in sample['processes']), path
        for process in sample['processes']:
            identity = (process['process'], process['started'])
            observed[identity] = max(observed.get(identity, 0), process['cpuSeconds'])
    assert len(observed) == report['observedProcessCount'], path
    assert abs(sum(observed.values()) - report['observedCpuSeconds']) < 0.000001, path
    assert max(sample['concurrentRssBytes'] for sample in report['samples']) == report['maximumSampledConcurrentRssBytes'], path
    resources.append({'path': str(path), 'sha256': digest(path), 'timedOut': report['timedOut'], 'interrupted': report['interrupted'], 'exitCode': report['exitCode'], 'cleanupSignals': report['cleanupSignals'], 'cleanup': report.get('cleanup')})

failures = []
for attempt, assessment in [
    ('034', 'Rust test compilation exhausted the unchanged 120-second watchdog before any unit or browser tests ran. The next attempt performed bounded build preparation before repeating the unchanged core checks.'),
    ('035', 'The 29-case lifecycle batch exhausted its unchanged 240-second job budget after a blocked-pointer case failed. The watchdog interrupted before unittest could print the failure traceback. No owned process/profile residue remained. This is not a full Linux pass.'),
]:
    path = next((destination / f'linux-{attempt}/evidence').glob('core-*/report.json'))
    report = read(path)
    assert report['sources'] == sources and report['status'] == 'failed' and not report['sourceChangedDuringVerification']
    for check in report['checks']:
        assert digest(path.parent / check['log']) == check['logSha256']
    failures.append({'path': str(path), 'sha256': digest(path), 'passedGroups': sum(check['code'] == 0 for check in report['checks']), 'assessment': assessment})
failures.append({'path': str(destination / 'native-001/diagnostics-before-fix.log'), 'driverSha256': digest('.cache/output-limits-001/flashwright-driver'), 'assessment': 'A deliberate regression against the first exploratory binary reproduced a 1200-unit error diagnostic escaping a negotiated 1000-node limit. The final code enforces the shared diagnostic budget; that exploratory failure is not a pass. The newly added diagnostic test ran against the archived earlier binary; its test source is in the final manifest, not the earlier nine-case manifest.'})

report = {
    'schemaVersion': 1,
    'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'scope': 'M1 outbound control-message bounds and resource publication. Functional evidence only, without a new performance or release claim.',
    'sources': sources,
    'nativeDriver': {'path': str(native_driver), 'sha256': digest(native_driver)},
    'linuxDriver': {'path': '.cache/linux-output-limits-036/flashwright-driver-linux-x64', 'sha256': digest('.cache/linux-output-limits-036/flashwright-driver-linux-x64')},
    'implementation': {
        'perCall': 'Results and errors are checked and encoded before transport writes. Oversize/depth/node failures reject only that call; input delivery and cleanup are preserved without replaying effects. Error UTF-16 messages and dynamic diagnostics share the payload node budget; fixed envelope metadata remains representable.',
        'allocationOwnership': 'Browsers, contexts and pages stay private until successful result validation and encoding. A rejected allocation receives bounded disposal. Page initialization refreshes its snapshot while holding the same lock that enables live events. Post-registration target-discovery failures also withdraw their browser.',
        'globalFailure': 'An event or handshake that cannot fit produces a bounded global resource error and closes the stream. Real partial/failed writes remain fatal. No requested payload is silently truncated.',
        'encoding': 'Bounded prepared replies enter the output queue once, avoiding a large result clone or a second serialization.',
    },
    'acceptedChecks': {
        'nativeCore': core, 'nativeCoreGroups': 54,
        'node22': {'path': str(destination / 'node22/report.json'), 'sha256': digest(destination / 'node22/report.json'), 'groups': 8},
        'linuxFocused': {'path': str(destination / 'linux-036/run.log'), 'sha256': digest(destination / 'linux-036/run.log'), 'outputLimitCases': 10, 'publicLifecycleCases': 10, 'browserWatchdogCases': 6, 'environmentClass': 'local-amd64-emulation-functional-only', 'containerImage': 'sha256:bf29c33e0d63f6e8ca909d3aa3ee22e10a34f9460466c6e156e47d521adfc005'},
        'sourceHashesMatchAcrossPlatforms': True,
        'resourceReportsIndependentlyRecomputed': len(resources),
    },
    'retainedFailures': failures,
    'resources': resources,
    'artifacts': {str(path): digest(path) for path in sorted(destination.rglob('*')) if path.is_file()},
    'remaining': ['Full Linux matrix verification remains incomplete; focused passes do not erase retained broad-batch failures. Native Linux remains a separate gate.', 'Additional launch-cancellation/concurrent-ownership and public unsupported/resource-limit coverage, platform packages and automatic binary selection.', 'M2 screenshots and remaining semantics, M3 transport, complete-flow performance, contention and release gates. Prior performance evidence applies only to its recorded binary.'],
}
with checkpoint.open('x') as output:
    json.dump(report, output, indent=2)
    output.write('\n')
print(f'Recorded {len(sources)} source hashes and {len(resources)} resource reports in {checkpoint}')
