from pathlib import Path
import datetime
import hashlib
import json
import re
import shutil
import subprocess


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def reference(path):
    return {'path': str(path), 'sha256': digest(path)}


native_path = Path(Path('.cache/resident-core-diagnostics-path.txt').read_text().strip())
native = read(native_path)
assert native['status'] == 'passed' and len(native['checks']) == 31
assert not native['sourceChangedDuringVerification'] and not native['browserChangedDuringVerification']
for check in native['checks']:
    assert check['code'] == 0 and digest(native_path.parent / check['log']) == check['logSha256']
rust = (native_path.parent / native['checks'][2]['log']).read_text()
assert sum(map(int, re.findall(r'test result: ok\. (\d+) passed', rust))) == 58
lifecycle_check = next(check for check in native['checks'] if check['command'] == ['npm', 'run', 'test:lifecycle'])
lifecycle = (native_path.parent / lifecycle_check['log']).read_text()
assert [int(count) for count in re.findall(r'Ran (\d+) tests', lifecycle)] == [21, 6, 10, 11, 11, 6]
assert lifecycle.count('\nOK\n') == 6
node22_path = Path('.cache/diagnostics-node22-001/report.json')
linux_path = Path('.cache/linux-diagnostics-047/evidence/diagnostics-focused-linux/report.json')
node22 = read(node22_path)
linux = read(linux_path)
for path, report, count in [(node22_path, node22, 7), (linux_path, linux, 10)]:
    assert report['status'] == 'passed' and len(report['checks']) == count, path
    assert not any(report[key] for key in ['sourceChangedDuringVerification', 'driverChangedDuringVerification', 'browserChangedDuringVerification'])
    assert report['sources'] == native['sources'], path
    for check in report['checks']:
        assert check['code'] == 0 and check['sha256'] == digest(path.parent / check['log']), check
sources = native['sources']
assert len(sources) == 191
for path, expected in sources.items():
    assert digest(path) == expected, path
assert native['driverSha256'] == node22['driverSha256'] == digest('.cache/diagnostics-002/flashwright-driver')
assert linux['driverSha256'] == digest('.cache/linux-diagnostics-047/flashwright-driver-linux-x64')
assert linux['environmentClass'] == 'local-amd64-emulation-functional-only'
linux_rust = (linux_path.parent / linux['checks'][2]['log']).read_text()
assert sum(map(int, re.findall(r'test result: ok\. (\d+) passed', linux_rust))) == 58
for path, report in [(node22_path, node22), (linux_path, linux)]:
    limits = (path.parent / report['checks'][-1]['log']).read_text()
    assert re.findall(r'Ran (\d+) tests', limits) == ['11'] and '\nOK\n' in limits
    assert 'test_oversized_page_exception_preserves_utf16_until_the_event_limit' in limits

audit = read('.cache/diagnostics-cleanup-audit.json')
assert not audit['remainingOwnedProcesses'] and not audit['remainingProfiles'] and not audit['remainingAttemptContainers']
assert not read('.cache/linux-diagnostics-047/container-audit.json')['remainingProfiles']
destination = Path('compatibility/evidence/diagnostics-integration-2026-10-08')
destination.mkdir()
for attempt in ['001', '002']:
    shutil.copytree(f'.cache/diagnostics-{attempt}', destination / f'native-{attempt}', ignore=shutil.ignore_patterns('flashwright-driver'))
shutil.copytree('.cache/diagnostics-node22-001', destination / 'node22')
shutil.copytree('.cache/linux-diagnostics-047', destination / 'linux-047', ignore=shutil.ignore_patterns('flashwright-driver-linux-x64'))
shutil.copytree('.cache/linux-image-rebuild-003', destination / 'linux-image-rebuild')
for name in ['verify-diagnostics-platform.mjs', 'linux-diagnostics-focused.sh', 'archive-diagnostics-core.py', 'audit-diagnostics.py', 'record-diagnostics.py', 'diagnostics-cleanup-audit.json']:
    shutil.copy2(Path('.cache') / name, destination / name)

comparisons = []
for root in [Path('compatibility/evidence'), destination / 'linux-047/evidence']:
    for path in sorted(root.glob('diagnostics-*/report.json')):
        report = read(path)
        if report.get('sources') != sources or 'outcomes' not in report:
            continue
        assert report['status'] == 'passed' and not report['sourceChangedDuringVerification'], path
        assert report['outcomes']['flashwright'] == report['outcomes']['reference'], path
        assert len(report['outcomes']['reference']['errors']) == 20
        assert len(report['outcomes']['reference']['lifecycle']) == 9
        comparisons.append({**reference(path), 'node': report['node'], 'browser': report['browser'], 'errorCases': 20, 'lifecycleChecks': 9})
assert len(comparisons) == 3, comparisons
resources = []
native_resources = [Path(name) for name in subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', 'compatibility/evidence/resources'], text=True).splitlines()]
for path in [*native_resources, *destination.glob('**/resources/*.json')]:
    report = read(path)
    assert not report['remainingObservedProcesses'], path
    observed = {}
    for sample in report['samples']:
        assert sample['concurrentRssBytes'] == sum(process['rssBytes'] for process in sample['processes']), path
        for process in sample['processes']:
            identity = (process['process'], process['started'])
            observed[identity] = max(observed.get(identity, 0), process['cpuSeconds'])
    assert len(observed) == report['observedProcessCount'], path
    assert abs(sum(observed.values()) - report['observedCpuSeconds']) < 0.000001, path
    assert max((sample['concurrentRssBytes'] for sample in report['samples']), default=0) == report['maximumSampledConcurrentRssBytes'], path
    resources.append({**reference(path), **{key: report[key] for key in ['timedOut', 'interrupted', 'exitCode', 'cleanupSignals', 'cleanup']}})
runtime_digest = hashlib.sha256()
runtime_files = Path('packages/resident-runtime/sources.txt').read_text().splitlines()
for name in runtime_files:
    data = (Path('packages/resident-runtime') / name).read_bytes()
    runtime_digest.update(len(data).to_bytes(8, 'little'))
    runtime_digest.update(data)
checkpoint = {
    'schemaVersion': 1, 'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'scope': 'M2 pageerror events and typed listeners/waits for the main page session and same-process child frames. Functional verification only; no performance or release claim.',
    'sources': sources, 'previousCheckpoint': reference('compatibility/evidence/screenshots-checkpoint-2026-10-08.json'),
    'provenance': reference('compatibility/upstream/page-error-provenance.json'),
    'contract': {
        'applicationProtocol': 5, 'requiredCapability': 'page.event.pageerror',
        'residentRuntimeSha256': runtime_digest.hexdigest(), 'residentRuntimeFiles': runtime_files,
        'values': 'A native JavaScript Error with the pinned reference name, message and exact browser stack. Original event JSON preserves lone UTF-16 surrogates through Rust. No additional renderer evaluation is needed.',
        'ownership': 'Deliver only to the live published page matching the originating browser session, independently of pending operations. Caught/evaluated exceptions are excluded. No error history is retained by the engine/client.',
        'bounds': 'The original CDP event remains subject to the ordinary 8 MiB browser event cap. Its JSON-text envelope is subject to the negotiated application control-frame cap (8 MiB default, 32 KiB in the fault fixture). Oversized output emits a bounded global ResourceLimitError and closes the stream; ownership cleanup is verified.',
    },
    'coverage': [
        'Twenty shared throws/rejections preserve names, messages and stacks: built-in and custom errors, multiline text, lone surrogates/NUL, custom/empty stacks, thrown primitives, objects, arrays, unhandled promises, a 20000-character message and syntax errors.',
        'Nine shared lifecycle checks cover caught/evaluated exclusion, listener identity/once/predicates, predicate failure and timeout listener cleanup, events during pending evaluation, same-process child frames, successor navigation, page isolation, ordered 32-event bursts and close/sibling survival.',
        'Packed fresh npm ESM/CommonJS consumers execute pageerror waits and typecheck inferred Error listeners; a negative type assertion prevents accidental any inference.',
        'A 40000-lone-surrogate exception while evaluation is pending triggers the negotiated output limit, preserves ResourceLimitError and releases owned browser/profile resources on all three checked platforms/configurations.',
    ],
    'verification': {
        'nativeCore': {**reference(native_path), 'groups': 31, 'rustTests': 58, 'lifecycleCases': 65, 'driverSha256': native['driverSha256']},
        'node22': {**reference(destination / 'node22/report.json'), 'groups': 7, 'outputLimitCases': 11},
        'linuxFocused': {**reference(destination / 'linux-047/evidence/diagnostics-focused-linux/report.json'), 'groups': 10, 'rustTests': 58, 'outputLimitCases': 11, 'driverSha256': linux['driverSha256'], 'environmentClass': linux['environmentClass'], 'containerImage': linux['containerImage']},
        'diagnosticComparisons': comparisons, 'resourcesIndependentlyRecomputed': len(resources),
    },
    'initialVerification': reference('compatibility/evidence/diagnostics-darwin-arm64-24.15.0-2026-10-08T15-16-21.868Z/report.json'),
    'environmentRecovery': 'The local Linux image tag was absent at inspection. The unchanged pinned Docker recipe was rebuilt using cached layers; the resulting image identity and build log are retained. No benchmark is derived from the emulated Linux run.',
    'cleanupAudit': reference(destination / 'diagnostics-cleanup-audit.json'), 'resourceReports': resources,
    'remaining': ['JSHandle/ElementHandle lifecycle, serialization and console arguments', 'Workers and out-of-process frame diagnostics, context error events and retained pageErrors history', 'Broader runner diagnostics/artifacts, M2 completion, M3 transport and material complete-flow speedup', 'Full current Linux core, native Linux CI/performance, contention, platform packages and remaining release gates'],
    'performance': 'No new performance claim. Previous timings remain bound to their recorded source/browser/binary snapshots.',
}
Path('compatibility/evidence/diagnostics-checkpoint-2026-10-08.json').write_text(json.dumps(checkpoint, indent=2)+'\n')
print(json.dumps({'comparisons': len(comparisons), 'sourceFiles': len(sources), 'resourcesRecomputed': len(resources), 'nativeDriver':native['driverSha256'], 'linuxDriver':linux['driverSha256']}, indent=2))
