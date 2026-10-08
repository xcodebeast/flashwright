from pathlib import Path
import datetime
import hashlib
import json
import shutil
import subprocess
import tempfile

destination = Path('compatibility/evidence/watchdog-cleanup-2026-10-08')
final_sources = json.loads(Path('.cache/watchdog-cleanup-002/sources.json').read_text())
linux_sources = json.loads(Path('.cache/linux-watchdog-033/sources.json').read_text())
assert final_sources == linux_sources
for name, expected in final_sources.items():
    assert hashlib.sha256(Path(name).read_bytes()).hexdigest() == expected, name
for name, tests in [('.cache/watchdog-cleanup-002/python-tests.log', 10), ('.cache/watchdog-cleanup-002/browser-watchdog.log', 6)]:
    contents = Path(name).read_text()
    assert f'Ran {tests} tests' in contents and contents.rstrip().endswith('OK'), name
linux_log = Path('.cache/linux-watchdog-033/run.log').read_text()
assert 'Ran 10 tests' in linux_log and 'Ran 6 tests' in linux_log and linux_log.rstrip().endswith('OK')
assert not list(Path(tempfile.gettempdir()).glob('flashwright-chromium-*'))
for attempt in ['031', '032', '033']:
    audit = json.loads(Path(f'.cache/linux-watchdog-{attempt}/container-audit.json').read_text())
    assert not audit['remainingProfiles'], attempt

destination.mkdir()
for label in ['001', '002']:
    shutil.copytree(f'.cache/watchdog-cleanup-{label}', destination / f'native-{label}')
for attempt in ['031', '032', '033']:
    directory = destination / f'linux-{attempt}'
    directory.mkdir()
    for path in Path(f'.cache/linux-watchdog-{attempt}').iterdir():
        if path.name == 'flashwright-driver-linux-x64':
            continue
        if path.is_dir():
            shutil.copytree(path, directory / path.name)
        else:
            shutil.copy2(path, directory / path.name)
for name in ['.cache/linux-storage-core.sh', '.cache/linux-watchdog-focused.sh', '.cache/linux-watchdog-final.sh', '.cache/record-watchdog-checkpoint.py']:
    shutil.copy2(name, destination / Path(name).name)
for name in ['tools/watchdog.py', 'tools/test_watchdog.py', 'tools/run-lifecycle-tests.mjs', 'compatibility/m1/watchdog_lifecycle.py']:
    shutil.copy2(name, destination / Path(name).name)

native_paths = subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', 'compatibility/evidence/resources'], text=True).splitlines()
resources = []
for path in [*map(Path, native_paths), *destination.glob('linux-*/evidence/resources/*.json')]:
    report = json.loads(path.read_text())
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
    resources.append({'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'timedOut': report['timedOut'], 'interrupted': report['interrupted'], 'exitCode': report['exitCode'], 'cleanupSignals': report['cleanupSignals'], 'cleanup': report.get('cleanup')})

linux_core = next((destination / 'linux-031/evidence').glob('core-*/report.json'))
core = json.loads(linux_core.read_text())
assert core['status'] == 'failed' and not core['sourceChangedDuringVerification']
before = json.loads((destination / 'linux-032/sources.json').read_text())
changed = [name for name in final_sources if final_sources[name] != before.get(name)]
assert changed == ['tools/test_watchdog.py', 'tools/watchdog.py'], changed
final_native_time = Path('.cache/watchdog-cleanup-002/sources.json').stat().st_mtime
final_native_cases = [str(path) for path in map(Path, native_paths) if path.name.startswith('browser-watchdog-') and path.stat().st_mtime > final_native_time]
assert len(final_native_cases) == 6
final_linux_cases = list((destination / 'linux-033/evidence/resources').glob('browser-watchdog-*.json'))
assert len(final_linux_cases) == 6

artifacts = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(destination.rglob('*')) if path.is_file()}
report = {
    'schemaVersion': 1,
    'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'scope': 'M1 external watchdog ownership cleanup. Native macOS arm64 Node24 and emulated Linux x64 Node24; functional evidence only. The engine binary is unchanged from the storage checkpoint.',
    'implementation': {'policy': 'Stop owned parent identities before descendants; allow orphan cleanup before promotion, including a zombie parent in the first snapshot. Escalate stuck owners individually, then the remaining whole tree.', 'graceSeconds': 2, 'stagedTimeoutSeconds': 10, 'forcedTimeoutSeconds': 2, 'unresolvedCleanupExitCode': 125, 'limit': 'Process-query and scheduling overhead can extend nominal intervals. Descendants that cannot finish cleanup before forced escalation remain an explicitly reported failure; arbitrary guardian termination is not a promise of profile recovery.'},
    'sources': final_sources,
    'nativeDriver': {'path': '.cache/storage-state-002/flashwright-driver', 'sha256': hashlib.sha256(Path('.cache/storage-state-002/flashwright-driver').read_bytes()).hexdigest()},
    'linuxDriver': {'path': '.cache/linux-watchdog-033/flashwright-driver-linux-x64', 'sha256': hashlib.sha256(Path('.cache/linux-watchdog-033/flashwright-driver-linux-x64').read_bytes()).hexdigest()},
    'acceptedChecks': {'pythonTestsPerPlatform': 10, 'browserCleanupTestsPerPlatform': 6, 'nativeCases': final_native_cases, 'linuxCases': [str(path) for path in final_linux_cases], 'sourceHashesMatchAcrossPlatforms': True, 'resourceReportsIndependentlyRecomputed': len(resources), 'modes': ['normal close', 'failed owner', 'job timeout', 'interruption', 'stopped worker', 'stopped driver'], 'additionalRegressions': ['Delayed child cleanup', 'SIGTERM-ignoring deep tree with bounded whole-tree escalation', 'Unrelated-process preservation', 'CPU reset and PID reuse accounting', 'Zombie-owner snapshot race']},
    'retainedFailures': [
        {'path': str(destination / 'native-001/lifecycle.log'), 'resourceReport': 'compatibility/evidence/resources/2026-10-08T08-23-17Z-feb28418.json', 'assessment': 'The native full lifecycle batch exceeded its unchanged 240-second job budget after two existing recovery-case errors. Staged shutdown completed without an observed process/profile residue. This is not a suite pass.'},
        {'path': str(linux_core), 'passedGroups': sum(check['code'] == 0 for check in core['checks']), 'assessment': 'The Linux full core batch exceeded its unchanged 240-second lifecycle budget after an existing context-close case failure. Its stopped-container audit found no owned profile. The full Linux matrix remains incomplete.'},
        {'path': str(destination / 'native-001/zombie-before-fix.log'), 'assessment': 'A deterministic regression reproduced immediate signalling of the guardian when the initial root snapshot was a zombie. The final policy grants the initial grace period to that state.'},
        {'assessment': 'An initial synthetic stopped-parent test assumed SIGTERM could not terminate a stopped macOS process. The fixture now explicitly ignores SIGTERM to require escalation on both platforms. The initial run was not a pass.'},
    ],
    'failureRechecks': {'native': str(destination / 'native-001/failure-recheck.log'), 'linux': str(destination / 'linux-032/run.log'), 'assessment': 'All three suspect existing renderer/keyboard/context-close cases passed separately on both platforms before the final zombie-only watchdog correction. Heavy shared-host activity was observed; it is a possible contributor, not a proven explanation of the full-batch failures. Their logs remain retained.'},
    'resources': resources,
    'artifacts': artifacts,
    'remaining': ['Complete full Linux verification and remaining lifecycle coverage under representative conditions; preserved timed-out batches are not passes.', 'Implement per-call oversized outbound-result handling, preserving input/effects and ownership without replay.', 'Complete remaining M1 packaging and M2 semantics/artifacts, M3 transport, native Linux, contention and release gates.'],
}
with (destination / 'report.json').open('x') as output:
    json.dump(report, output, indent=2)
    output.write('\n')
print(f'Recorded {len(final_sources)} source hashes and {len(resources)} resource reports in {destination}/report.json')
