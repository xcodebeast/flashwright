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


previous_path = 'compatibility/evidence/binary-attachments-checkpoint-2026-10-08.json'
previous = read(previous_path)
native = read('.cache/lifecycle-budget-001/native-report.json')
node22 = read('.cache/lifecycle-budget-001/node22-report.json')
sources = native['sources']
assert len(sources) == 178 and node22['sources'] == sources
changed = {name for name, expected in sources.items() if previous['sources'].get(name) != expected}
assert changed == {'tools/run-lifecycle-tests.mjs', 'compatibility/m1/client-deadline.mjs', 'compatibility/m1/test_driver_protocol.py'}, changed
for name, expected in sources.items():
    assert digest(name) == expected, name
assert native['status'] == node22['status'] == 'passed'
assert digest('.cache/lifecycle-budget-001/native.log') == native['logSha256']
assert digest('.cache/lifecycle-budget-001/node22.log') == node22['logSha256']
assert native['driverSha256'] == previous['nativeDriver']['sha256']
linux_path = next(Path('.cache/linux-lifecycle-budget-039/evidence').glob('core-*/report.json'))
linux = read(linux_path)
assert linux['status'] == 'passed' and len(linux['checks']) == 27
assert linux['sources'] == sources and not linux['sourceChangedDuringVerification'] and not linux['browserChangedDuringVerification']
assert linux['driverSha256'] == previous['linuxDriver']['sha256'] == digest('.cache/linux-lifecycle-budget-039/flashwright-driver-linux-x64')
assert linux['environmentClass'] == 'local-amd64-emulation-functional-only'
for check in linux['checks']:
    assert check['code'] == 0 and digest(linux_path.parent / check['log']) == check['logSha256']
log = (linux_path.parent / linux['checks'][13]['log']).read_text()
assert log.count('\nOK\n') == 6 and log.count('Deadline scenario ') == 9
assert 'Ran 21 tests' in log and log.count('Ran 6 tests') == 2 and log.count('Ran 10 tests') == 2 and 'Ran 5 tests' in log
audit = read('.cache/lifecycle-budget-cleanup-audit.json')
assert not audit['remainingOwnedProcesses'] and not audit['remainingProfiles'] and not audit['remainingAttemptContainers']
assert not read('.cache/linux-lifecycle-budget-039/container-audit.json')['remainingProfiles']

destination = Path('compatibility/evidence/lifecycle-budget-2026-10-08')
destination.mkdir()
shutil.copytree('.cache/lifecycle-budget-001', destination / 'native')
shutil.copytree('.cache/linux-lifecycle-budget-039', destination / 'linux', ignore=shutil.ignore_patterns('flashwright-driver-linux-x64'))
for name in ['linux-lifecycle-budget-core.sh', 'record-lifecycle-budget.py', 'lifecycle-budget-cleanup-audit.json']:
    shutil.copy2(Path('.cache') / name, destination / name)

resources = []
paths = [*destination.glob('native/resources/*.json'), *destination.glob('linux/evidence/resources/*.json')]
paths += [Path(name) for name in subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', 'compatibility/evidence/resources'], text=True).splitlines()]
for path in paths:
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

report = {
    'schemaVersion': 1,
    'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'scope': 'Lifecycle harness budgets and a complete functional Linux matrix under amd64 emulation. Production sources and native/Linux drivers are unchanged from the binary-attachment checkpoint. No speed or release claim.',
    'sources': sources,
    'changedSources': sorted(changed),
    'previousCheckpoint': {'path': previous_path, 'sha256': digest(previous_path)},
    'rootCause': 'One Python case gave nine independent client processes a shared ten-second subprocess budget. A retained diagnostic run completed each scenario cleanly but required 13.847 seconds in total. A separate 240-second watchdog covered all lifecycle modules and expired after successful earlier modules consumed most of the budget.',
    'change': 'Each deadline scenario is now a named Python case with the original ten-second subprocess bound. Every discovered test_*.py module receives its own 240-second watchdog; the output-limit, binary-attachment and watchdog modules retain their 180-second bounds. Public operation timeouts, cancellation cleanup and per-case assertions are unchanged. Splitting one case into nine changes the counted lifecycle total from 50 to 58 without dropping or weakening a scenario.',
    'verification': {
        'nativeLifecycle': {'path': str(destination / 'native/native-report.json'), 'sha256': digest(destination / 'native/native-report.json'), 'cases': 58},
        'node22Deadline': {'path': str(destination / 'native/node22-report.json'), 'sha256': digest(destination / 'native/node22-report.json'), 'cases': 9},
        'linuxCore': {'path': str(destination / 'linux/evidence' / linux_path.parent.name / 'report.json'), 'groups': 27, 'lifecycleCases': 58, 'browser': linux['browser'], 'configuration': linux['engineConfiguration'], 'driverSha256': linux['driverSha256'], 'environmentClass': linux['environmentClass'], 'containerImage': linux['containerImage']},
        'nativeDriverSha256': native['driverSha256'],
        'resourcesIndependentlyRecomputed': len(resources),
    },
    'resources': resources,
    'artifacts': {str(path): digest(path) for path in sorted(destination.rglob('*')) if path.is_file()},
    'remaining': ['Native Linux execution/performance remains open; amd64 emulation is functional evidence only.', 'Broader browser payload admission, M2 screenshots and remaining semantics, installation/aliases, complete-flow material improvement, contention and release gates remain open.', 'Earlier failed attempts remain retained in their immutable checkpoints; this successful matrix does not relabel them as passes.'],
}
checkpoint = Path('compatibility/evidence/lifecycle-budget-checkpoint-2026-10-08.json')
with checkpoint.open('x') as output:
    json.dump(report, output, indent=2)
    output.write('\n')
print(f'Recorded complete Linux matrix, 58 native lifecycle cases and {len(resources)} recomputed resource reports.')
