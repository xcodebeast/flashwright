from pathlib import Path
import datetime
import hashlib
import json
import shutil
import subprocess


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


destination = Path('compatibility/evidence/binary-attachments-integration-2026-10-08')
checkpoint = Path('compatibility/evidence/binary-attachments-checkpoint-2026-10-08.json')
native_path = Path(Path('.cache/resident-core-attachments-full-chrome-on-path.txt').read_text().strip())
native = read(native_path)
sources = native['sources']
assert len(sources) == 178
for name, expected in sources.items():
    assert digest(name) == expected, name
native_driver = Path('.cache/attachments-002/flashwright-driver')
assert native['status'] == 'passed' and len(native['checks']) == 27
assert not native['sourceChangedDuringVerification'] and not native['browserChangedDuringVerification']
assert native['driverSha256'] == digest(native_driver)
for check in native['checks']:
    assert check['code'] == 0 and digest(native_path.parent / check['log']) == check['logSha256']
lifecycle = (native_path.parent / native['checks'][13]['log']).read_text()
for count in [29, 10, 5, 6]:
    assert f'Ran {count} tests' in lifecycle
assert lifecycle.count('\nOK\n') == 4

node22 = read('.cache/attachments-node22/report.json')
assert node22['status'] == 'passed' and len(node22['checks']) == 4
assert node22['sources'] == sources and node22['driverSha256'] == digest(native_driver)
assert not node22['sourceChangedDuringVerification'] and not node22['driverChangedDuringVerification'] and not node22['browserChangedDuringVerification']
for check in node22['checks']:
    assert check['code'] == 0 and check['sha256'] == digest(Path('.cache/attachments-node22') / check['log'])
headless_log = Path('.cache/attachments-node22/binary-browser.log').read_text()
assert 'Ran 5 tests' in headless_log and '\nOK\n' in headless_log

linux_log = Path('.cache/linux-attachments-038/run.log').read_text()
assert linux_log.count('Ran 10 tests') == 2 and 'Ran 5 tests' in linux_log and 'Ran 6 tests' in linux_log
assert linux_log.count('\nOK\n') == 4
assert read('.cache/linux-attachments-038/sources.json') == sources
phases = [json.loads(line) for line in linux_log.splitlines() if line.startswith('{"phase":')]
closed = [phase for phase in phases if phase['phase'] == 'close']
assert len(closed) == 9 and all(phase['code'] == 0 and phase['signal'] is None for phase in closed)
for attempt in ['037', '038']:
    assert not read(f'.cache/linux-attachments-{attempt}/container-audit.json')['remainingProfiles']
cleanup = read('.cache/attachments-cleanup-audit.json')
assert not cleanup['remainingOwnedProcesses'] and not cleanup['remainingProfiles'] and not cleanup['remainingAttemptContainers']

destination.mkdir()
for sequence in ['001', '002']:
    shutil.copytree(f'.cache/attachments-{sequence}', destination / f'native-{sequence}', ignore=shutil.ignore_patterns('flashwright-driver'))
shutil.copytree('.cache/attachments-node22', destination / 'node22')
for attempt in ['037', '038']:
    shutil.copytree(f'.cache/linux-attachments-{attempt}', destination / f'linux-{attempt}', ignore=shutil.ignore_patterns('flashwright-driver-linux-x64'))
for name in ['verify-attachments-node22.mjs', 'linux-attachments-core.sh', 'linux-attachments-focused.sh', 'trace-client-lifecycle.mjs', 'record-attachments.py', 'attachments-cleanup-audit.json']:
    shutil.copy2(Path('.cache') / name, destination / name)

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

linux_path = next((destination / 'linux-037/evidence').glob('core-*/report.json'))
linux = read(linux_path)
assert linux['sources'] == sources and linux['status'] == 'failed' and not linux['sourceChangedDuringVerification']
assert linux['driverSha256'] == digest('.cache/linux-attachments-038/flashwright-driver-linux-x64')
for check in linux['checks']:
    assert digest(linux_path.parent / check['log']) == check['logSha256']

report = {
    'schemaVersion': 1,
    'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'scope': 'M1 application binary attachments, exercised through existing response.body. Functional evidence only; no new performance or release claim.',
    'sources': sources,
    'applicationProtocolVersion': 5,
    'nativeDriver': {'path': str(native_driver), 'sha256': digest(native_driver), 'profile': 'debug'},
    'linuxDriver': {'path': '.cache/linux-attachments-038/flashwright-driver-linux-x64', 'sha256': digest('.cache/linux-attachments-038/flashwright-driver-linux-x64'), 'profile': 'debug'},
    'implementation': {
        'framing': 'JSON start and terminal envelopes delimit request-scoped binary frames with exact encoded offsets and lengths. Raw bytes and canonical base64 groups are distinct encodings; the client exposes a Buffer only after complete terminal delivery.',
        'resources': 'Negotiated defaults are 32 MiB decoded per payload and two active payloads. Producers use a one-frame channel and at most 64 KiB chunk payloads, obeying the control-frame cap. The writer interleaves replies/events and retains the payload reservation through terminal acknowledgement.',
        'cancellation': 'Caller expiry releases partial assembled bytes while still validating late frames. Driver cancellation discards unsent chunks, sends one terminal error, and releases its slot. A failed or incomplete stream fails explicitly.',
        'browserRepresentation': 'Existing Chromium base64 stays encoded until the Node receiver decodes bounded chunks. This removes a redundant Rust decode/re-encode but is not a measured speed claim.',
        'diagnostics': 'Python lifecycle failures print tracebacks immediately, so a later watchdog cannot erase their diagnosis.',
    },
    'acceptedChecks': {
        'nativeCore': {'path': str(native_path), 'sha256': digest(native_path), 'groups': 27, 'lifecycleCases': 50, 'nodeHarnessCases': 17, 'pythonHarnessCases': 11, 'browser': native['browser'], 'configuration': native['engineConfiguration']},
        'node22': {'path': str(destination / 'node22/report.json'), 'sha256': digest(destination / 'node22/report.json'), 'groups': 4, 'additionalBinaryBrowserCases': 5, 'browser': node22['browser']},
        'linuxFocused': {'path': str(destination / 'linux-038/run.log'), 'sha256': digest(destination / 'linux-038/run.log'), 'binaryBrowserCases': 5, 'outputLimitCases': 10, 'publicLifecycleCases': 10, 'browserWatchdogCases': 6, 'environmentClass': 'local-amd64-emulation-functional-only', 'containerImage': 'sha256:bf29c33e0d63f6e8ca909d3aa3ee22e10a34f9460466c6e156e47d521adfc005'},
        'payloadCoverage': 'Real Chromium tests cross a negotiated 32768-byte control cap with a 1 MiB binary body and UTF-8/NUL text. The synthetic client peer delivers a 9 MiB payload beyond the default 8 MiB control cap. That synthetic test is not coverage of a large CDP reply.',
        'sourceHashesMatchAcrossPlatforms': True,
        'resourceReportsIndependentlyRecomputed': len(resources),
    },
    'retainedFailures': [
        {'path': str(destination / 'native-001/native-tests.log'), 'assessment': 'The first empty-body fixture assumed the response event had arrived with the page-evaluation result and raised StopIteration. The corrected fixture waits explicitly for the independently delivered event. This exploratory run is not accepted final conformance.'},
        {'path': str(linux_path), 'sha256': digest(linux_path), 'passedGroups': sum(check['code'] == 0 for check in linux['checks']), 'assessment': 'The broad lifecycle batch exceeded its unchanged 240-second watchdog. Its first case also exhausted a 10-second aggregate subprocess budget around nine client launches. A separate instrumented rerun completed all nine scenarios and clean exits in 13.847 seconds. This diagnoses an inadequate aggregate fixture allowance; it does not turn the failed broad run into a pass. No owned process or profile residue remained.'},
    ],
    'resources': resources,
    'artifacts': {str(path): digest(path) for path in sorted(destination.rglob('*')) if path.is_file()},
    'remaining': ['Repair aggregate lifecycle fixture budgeting and complete the full Linux matrix; native Linux remains a separate gate.', 'The browser CDP reader still caps individual incoming messages at 8 MiB. Larger browser payload admission and failure behavior must be addressed before broad screenshot support; the application 32 MiB limit alone does not provide that coverage.', 'M2 screenshots and remaining semantics, M3 browser transport, platform packages, complete-flow performance, contention and release gates. Prior performance applies only to its recorded binary.'],
}
with checkpoint.open('x') as output:
    json.dump(report, output, indent=2)
    output.write('\n')
print(f'Recorded {len(sources)} source hashes and {len(resources)} resource reports in {checkpoint}')
