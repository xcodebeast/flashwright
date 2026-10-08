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


native_path = Path(Path('.cache/resident-core-handles-001-path.txt').read_text().strip())
node22_path = Path('.cache/handles-node22-001/report.json')
linux_path = Path('.cache/linux-handles-048/evidence/handles-focused-linux/report.json')
native, node22, linux = [read(path) for path in [native_path, node22_path, linux_path]]
sources = native['sources']
assert len(sources) == 199
for path, expected in sources.items():
    assert digest(path) == expected, path
for path, report, count, log_key in [(native_path, native, 33, 'logSha256'), (node22_path, node22, 10, 'sha256'), (linux_path, linux, 13, 'sha256')]:
    assert report['status'] == 'passed' and len(report['checks']) == count, path
    assert report['sources'] == sources, path
    assert not any(report.get(key, False) for key in ['sourceChangedDuringVerification', 'driverChangedDuringVerification', 'browserChangedDuringVerification'])
    for check in report['checks']:
        assert check['code'] == 0 and digest(path.parent / check['log']) == check[log_key], check
for path, report in [(native_path, native), (linux_path, linux)]:
    rust = (path.parent / report['checks'][2]['log']).read_text()
    assert sum(map(int, re.findall(r'test result: ok\. (\d+) passed', rust))) == 62
lifecycle_check = next(check for check in native['checks'] if check['command'] == ['npm', 'run', 'test:lifecycle'])
lifecycle = (native_path.parent / lifecycle_check['log']).read_text()
assert [int(count) for count in re.findall(r'Ran (\d+) tests', lifecycle)] == [22, 7, 6, 10, 11, 11, 6]
assert lifecycle.count('\nOK\n') == 7
for path, report in [(node22_path, node22), (linux_path, linux)]:
    for pattern, count in [('output_limits.py', '11'), ('test_handles.py', '7')]:
        check = next(check for check in report['checks'] if check['command'][-1] == pattern)
        log = (path.parent / check['log']).read_text()
        assert re.findall(r'Ran (\d+) tests', log) == [count] and '\nOK\n' in log
assert native['driverSha256'] == node22['driverSha256'] == digest('.cache/handles-core-001/flashwright-driver')
assert linux['driverSha256'] == digest('.cache/linux-handles-048/flashwright-driver-linux-x64')
assert linux['environmentClass'] == 'local-amd64-emulation-functional-only'
audit = read('.cache/handles-cleanup-audit.json')
assert not audit['remainingOwnedProcesses'] and not audit['remainingProfiles'] and not audit['remainingAttemptContainers']
assert not read('.cache/linux-handles-048/container-audit.json')['remainingProfiles']

destination = Path('compatibility/evidence/handles-integration-2026-10-08')
destination.mkdir()
for folder in sorted(Path('.cache').glob('handles-*')):
    if folder.is_dir() and folder.name != 'handles-node22-001':
        shutil.copytree(folder, destination / folder.name, ignore=shutil.ignore_patterns('flashwright-driver'))
shutil.copytree('.cache/handles-node22-001', destination / 'node22')
shutil.copytree('.cache/linux-handles-048', destination / 'linux-048', ignore=shutil.ignore_patterns('flashwright-driver-linux-x64'))
shutil.copytree('.cache/linux-image-rebuild-004', destination / 'linux-image-rebuild')
for name in ['verify-handles-platform.mjs', 'linux-handles-focused.sh', 'archive-handles-core.py', 'audit-handles.py', 'record-handles.py', 'handles-cleanup-audit.json']:
    shutil.copy2(Path('.cache') / name, destination / name)

comparisons = []
for root in [Path('compatibility/evidence'), destination / 'linux-048/evidence']:
    for path in sorted(root.glob('handles-*/report.json')):
        report = read(path)
        if report.get('sources') != sources or 'outcomes' not in report:
            continue
        assert report['status'] == 'passed' and not report['sourceChangedDuringVerification'], path
        assert report['outcomes']['flashwright'] == report['outcomes']['reference'], path
        assert len(report['outcomes']['reference']) == 9
        assert report['referenceDifferences']['reference']['bigintJsonType'] == 'undefined'
        assert report['referenceDifferences']['flashwright']['bigintJsonType'] == 'bigint'
        comparisons.append({**reference(path), 'node': report['node'], 'browser': report['browser'], 'sharedGroups': 9, 'primitiveCases': 10, 'referenceDifference': report['referenceDifferences']})
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
    'scope': 'M2 JSHandle and ElementHandle base lifecycle, supported graph serialization, original-context evaluation and same-process frame evaluation. Functional verification only; no performance or release claim.',
    'sources': sources, 'previousCheckpoint': reference('compatibility/evidence/diagnostics-checkpoint-2026-10-08.json'),
    'provenance': reference('compatibility/upstream/handle-value-provenance.json'),
    'contract': {
        'applicationProtocol': 5,
        'requiredCapabilities': ['page.evaluateHandle', 'frame.evaluate', 'frame.evaluateHandle', 'handle.evaluate', 'handle.evaluateHandle', 'handle.jsonValue', 'handle.getProperty', 'handle.getProperties', 'handle.dispose', 'handle.discard'],
        'residentRuntimeSha256': runtime_digest.hexdigest(), 'residentRuntimeFiles': runtime_files,
        'values': 'Existing bounded graph values and exact UTF-16 property names/strings. Nested and repeated handles unbox with object identity; ElementHandles retain their exact DOM object after detachment. Browser Node/Document/Window values serialize to pinned reference descriptions, including inside graphs. Maps/functions/symbols can remain handles and be evaluated, but their by-value serialization remains explicitly unsupported.',
        'ownership': 'Object references remain in their original page/frame/unique context. Primitive values survive navigation and may cross live pages in the same engine. Destroyed object contexts free native slots; explicit disposal is idempotent. Property handles own separate native references and remain alive after parent or sibling disposal. New allocations are grouped privately, published only after reply encoding, and discarded on cancellation, output rejection or late caller success.',
        'bounds': 'At most 4096 retained or pending handles per page. Exhaustion rejects before user evaluation. Incomplete property allocation rolls back its private group. Ordinary CDP property replies retain their 8 MiB cap; application results obey negotiated bytes/depth/nodes. Cleanup has a separate 500 ms recovery budget and retires the affected page when its pending allocation cannot be recovered safely.',
        'intentionalDifference': 'SPECS S4.l: preserve primitive BigInt values. Pinned Playwright 1.60.0 converts its Chromium BigInt handle to undefined. Creation preview, jsonValue, argument passing and receiver evaluation are recorded separately, never counted as equal-result conformance or a speedup.',
    },
    'coverage': [
        'Nine shared browser groups cover ten primitive edge values, graph identity/cycles, nested handle arguments, Unicode properties, getter behavior, independent reference disposal, DOM detachment/reference values, nonserializable object evaluation, failures without replay, concurrent evaluation, foreign-object rejection, same-process frame ownership, navigation and page closure.',
        'Seven native lifecycle/publication cases cover the 4096-slot bound, slot reuse after disposal/navigation, partial property rollback, cancelled shared preparation, timed-out synchronous and deferred allocations, rejected primitive output and ten repeated rejected property groups.',
        'Caller-deadline fake-peer cases cover late success from all five allocation APIs and verify precise group discard before timeout rejection.',
        'Fresh packed npm ESM/CommonJS consumers run handle operations and typecheck inferred unboxed arguments, property handles, element subtypes, asElement and frame evaluation with negative type assertions.',
        'Raw CDP replies preserve escaped lone surrogates, reject oversized property payloads without corrupting subsequent replies, and discard late cancelled responses. The UTF-16 decoder tests every single UTF-16 code unit plus mixed escaped/literal text.',
    ],
    'verification': {
        'nativeCore': {**reference(native_path), 'groups': 33, 'rustTests': 62, 'lifecycleCases': 73, 'driverSha256': native['driverSha256']},
        'node22': {**reference(destination / 'node22/report.json'), 'groups': 10, 'outputLimitCases': 11, 'handleLifecycleCases': 7},
        'linuxFocused': {**reference(destination / 'linux-048/evidence/handles-focused-linux/report.json'), 'groups': 13, 'rustTests': 62, 'outputLimitCases': 11, 'handleLifecycleCases': 7, 'driverSha256': linux['driverSha256'], 'environmentClass': linux['environmentClass'], 'containerImage': linux['containerImage']},
        'handleComparisons': comparisons, 'resourcesIndependentlyRecomputed': len(resources),
    },
    'developmentAttempts': 'Earlier reference probes, smoke/build/lifecycle runs and initial differential are retained under the integration directory or their timestamped report. They precede the final frozen source. Build attempt 004 exposed generic asElement assignability errors; its dependent deadline launch also failed because the package build had not completed. The repaired types pass the final package and platform checks. These attempts are not part of final-source verification.',
    'environmentRecovery': 'The local Linux image tag was absent at inspection. The unchanged pinned Docker recipe was rebuilt using cached layers; its resulting image identity and build log are retained. Emulated Linux results are functional evidence only.',
    'cleanupAudit': reference(destination / 'handles-cleanup-audit.json'), 'resourceReports': resources,
    'remaining': ['Console arguments and broader diagnostic/runner integration', 'ElementHandle actions/reads, cross-context element adoption, additional by-value classes and out-of-process frame evaluation', 'Workers and broader pageerror events/history, screenshot masks/comparison, remaining M2 and M3 transport', 'Full current Linux core, native Linux CI/performance, contention, platform packages, material complete-flow speedup and release gates'],
    'performance': 'No new performance claim. Previous timings remain bound to their recorded source/browser/binary snapshots.',
}
Path('compatibility/evidence/handles-checkpoint-2026-10-08.json').write_text(json.dumps(checkpoint, indent=2)+'\n')
print(json.dumps({'comparisons': len(comparisons), 'sourceFiles': len(sources), 'resourcesRecomputed': len(resources), 'nativeDriver':native['driverSha256'], 'linuxDriver':linux['driverSha256']}, indent=2))
