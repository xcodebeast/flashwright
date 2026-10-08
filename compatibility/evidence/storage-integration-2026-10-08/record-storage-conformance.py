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


failed_linux_attempts = []
for sequence, reason in [
    ('027', 'Rosetta readlinkat /proc assertion interrupted the intentional-failure setup fixture before its deliberate failure. No source change, watchdog timeout or forced cleanup.'),
    ('029', 'The full fixed-source run exhausted the 240-second lifecycle-job budget under amd64 emulation. The watchdog forced cleanup and still observed one process at its final sample; the stopped container retained an owned profile. Its removal released that writable layer. This failed run is not a conformance pass; watchdog cleanup and the final full Linux matrix remain open.'),
    ('028', 'All preceding 26 groups passed, but storage collection failed when Chromium cancelled a prior-document interception during origin traversal. Production now consumes only the exact stale-interception rejection without replay; unrelated failures still propagate. Two protocol-level unit cases and repeated real multi-origin snapshots cover the fix.'),
]:
    output = Path('.cache/linux-core-' + sequence + '/evidence')
    failed_report = next(output.glob('core-*/report.json'))
    assert read(failed_report)['status'] == 'failed'
    assert not read(failed_report)['sourceChangedDuringVerification']
    shutil.copytree(output, 'compatibility/evidence', dirs_exist_ok=True)
    failed_path = Path('compatibility/evidence') / failed_report.parent.name / 'report.json'
    failed_linux_attempts.append({'path': str(failed_path), 'sha256': digest(failed_path), 'assessment': reason})
linux_output = Path('.cache/linux-storage-030')
shutil.copytree(linux_output / 'evidence', 'compatibility/evidence', dirs_exist_ok=True)
core_paths = [Path('.cache/resident-core-storage-r2-' + label + '-path.txt').read_text().strip() for label in ['headless-on', 'headless-off', 'full-chrome-on']]
provenance = read('compatibility/upstream/cookie-helpers-provenance.json')
assert digest(provenance['distributionSource']) == provenance['distributionSha256']
assert digest(provenance['retainedExtract']) == provenance['extractSha256']
sources = read(core_paths[0])['sources']
for path, expected in sources.items():
    assert digest(path) == expected, path
core = []
registry = []
storage = []
for path in core_paths:
    report = read(path)
    assert report['status'] == 'passed' and len(report['checks']) == 27 and report['sources'] == sources
    assert not report['sourceChangedDuringVerification'] and not report['browserChangedDuringVerification']
    for check in report['checks']:
        assert check['code'] == 0 and digest(Path(path).parent / check['log']) == check['logSha256']
    binary = linux_output / 'flashwright-driver-linux-x64' if report['platform'] == 'linux' else Path('.cache/storage-state-002/flashwright-driver')
    assert digest(binary) == report['driverSha256']
    core.append({'path': path, 'sha256': digest(path), 'checks': len(report['checks']), 'logsVerified': True, 'driverSha256': report['driverSha256'], 'browser': report['browser'], 'configuration': report['engineConfiguration'], 'environmentClass': report['environmentClass']})
    log = (Path(path).parent / report['checks'][19]['log']).read_text()
    registry_path = Path(re.findall(r'Resident registry evidence: (.+)', log)[-1])
    case_report = read(registry_path)
    assert case_report['sources'] == sources and len(case_report['cases']) == 57
    registry.append({'path': str(registry_path), 'sha256': digest(registry_path), 'cases': len(case_report['cases'])})
    log = (Path(path).parent / report['checks'][26]['log']).read_text()
    storage_path = Path(re.findall(r'Storage differential passed: (.+)', log)[-1])
    result = read(storage_path)
    assert result['status'] == 'passed' and result['sources'] == sources
    assert result['serviceWorkerObservations']['reference']['applicationCodeRanDuringSnapshot'] is True
    assert result['serviceWorkerObservations']['flashwright']['applicationCodeRanDuringSnapshot'] is False
    storage.append({'path': str(storage_path), 'sha256': digest(storage_path), 'referenceSnapshotExecutedWorkerSuppliedDocument': True, 'candidateSnapshotPreservedOriginalState': True})
    if report['platform'] == 'linux':
        artifacts = Path(path).parent / 'artifacts'
        artifacts.mkdir()
        for source in (linux_output / 'evidence').glob('*.json'):
            shutil.copy2(source, artifacts / source.name)

linux_storage_paths = sorted((linux_output / 'evidence').glob('storage-*/report.json'))
assert len(linux_storage_paths) == 3
for original_path in linux_storage_paths:
    path = Path('compatibility/evidence') / original_path.parent.name / 'report.json'
    result = read(path)
    assert result['status'] == 'passed' and result['sources'] == sources
    assert result['driverSha256'] == digest(linux_output / 'flashwright-driver-linux-x64')
    assert result['serviceWorkerObservations']['reference']['applicationCodeRanDuringSnapshot'] is True
    assert result['serviceWorkerObservations']['flashwright']['applicationCodeRanDuringSnapshot'] is False
    storage.append({'path': str(path), 'sha256': digest(path), 'scope': 'Focused complete storage corpus on Linux x64 under emulation, after the interception fix; not a full-core pass.'})

node22_log = Path('compatibility/evidence/storage-node22-2026-10-08.txt')
node22_text = node22_log.read_text()
assert 'Ran 29 tests' in node22_text and '\nOK\n' in node22_text
for expected in ['Real Chromium library smoke passed', 'Native runner evidence:', 'Packed library consumers passed:']:
    assert expected in node22_text
node22_registry = Path(re.findall(r'Resident registry evidence: (.+)', node22_text)[-1])
assert read(node22_registry)['sources'] == sources and len(read(node22_registry)['cases']) == 57
node22_storage = Path(re.findall(r'Storage differential passed: (.+)', node22_text)[-1])
assert read(node22_storage)['sources'] == sources and read(node22_storage)['status'] == 'passed'
exploration = Path('compatibility/evidence/storage-integration-2026-10-08')
exploration.mkdir()
for source in list(Path('.cache').glob('storage*.log')) + [Path('.cache/verify-storage.sh'), Path('.cache/verify-storage-r2.sh'), Path('.cache/update-storage-docs.py'), Path('.cache/storage-linux-028-container-audit.json'), Path('.cache/storage-linux-029-container-audit.json'), Path('.cache/storage-linux-030-container-audit.json'), Path('.cache/linux-storage-focused.sh'), Path('.cache/linux-storage-core.sh'), Path('.cache/archive-storage-core.py'), Path('.cache/record-storage-conformance.py')]:
    shutil.copy2(source, exploration / source.name)
attempts = []
for path in sorted(Path('compatibility/evidence').glob('storage-*/report.json')):
    if path.parent == exploration:
        continue
    result = read(path)
    if 'outcomes' in result:
        attempts.append({'path': str(path), 'sha256': digest(path), 'status': result['status'], 'error': result.get('error', {}).get('message')})
save(exploration / 'report.json', {
    'sources': sources,
    'attempts': attempts,
    'failedLinuxAttempts': failed_linux_attempts,
    'initialFailures': [
        'Linux attempt 028 caught Invalid InterceptionId during a successor-origin snapshot. The production interceptor now consumes that exact native cancellation rejection without replay while preserving every unrelated protocol failure; no blanket catch was introduced.',
        'TypeScript required explicit canonical-cookie field narrowing; the fixed package build passed.',
        'The initial child-origin fixture called Frame.evaluate, which is not in the implemented slice; the fixture now uses a supported child-frame locator after the child script reads its storage.',
        'An unsafe-port navigation did not fail because interception fulfilled it. The restoration rollback case now uses a native invalid cookie rejection and asserts acknowledged resource disposal.',
        'Rust clippy required the test module to follow implementation items; the module was moved without changing behavior.',
        'The worker fixture exposed a pinned-reference side effect: fallback storage collection ran a service-worker-supplied document and mutated storage. It is preserved as a separate observed difference in SPECS S4.j, not erased from differential claims.',
        'The initial cookie sort used JSON property order, which differs between the reference and Rust. Sorting now uses explicit cookie identity fields; complete cookie payloads remain compared.',
        'The strengthened rollback fixture initially read error.cleanup instead of the public error.details.cleanup. Correcting that access verified the resourceDisposed acknowledgement.',
    ],
    'tests': ['Two deterministic connection-level cases prove cancelled interception does not replay or fail a successor and unrelated errors remain visible', 'Six repeated multi-origin snapshots per browser corpus cover prior-document subresource cancellation', 'Native cookie attributes, expiry, replacement, URL/domain/path filtering, regex deletion and partitioned cookies', 'Cookie-only state restoration with partition metadata and no public page', 'Exact UTF-16 localStorage values and keys including lone surrogates, NUL, astral text and special property names', 'HTTP and HTTPS origin restoration without backend requests', 'Real HTTP Set-Cookie login authenticated after object/file restoration before page startup', 'Closed-page and same-process child origins, empty-origin omission and sessionStorage exclusion', 'Bounded collection, preserved prior state file after failure and recovery of the existing page', 'Native batch rejection before partial cookie application and failed-context rollback', 'Stopped-browser cookie read deadline, context-close interruption and uncertain-mutation owner retirement', 'Runner context-option inheritance, explicit state override and state-file fixture', 'Packed ESM/CommonJS runtime and declaration round trips'],
    'files': {path.name: digest(path) for path in exploration.iterdir()},
})

resources = []
failed_watchdogs = []
for name in subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', 'compatibility/evidence/resources'], text=True).splitlines():
    report = read(name)
    if report['timedOut'] or report['interrupted'] or report['cleanupSignals'] or report['remainingObservedProcesses']:
        assert Path(name).name == '2026-10-08T07-50-15Z-f92c5ee6.json', name
        failed_watchdogs.append({'path': name, 'sha256': digest(name), 'timeoutSeconds': report['timeoutSeconds'], 'elapsedSeconds': report['elapsedSeconds'], 'remainingObservedProcesses': report['remainingObservedProcesses'], 'cleanupSignals': report['cleanupSignals'], 'disposition': 'Retained failed emulated Linux full-run watchdog. Owned stopped container 029 was removed after a profile audit; this is not normal cleanup or a passing check.'})
    resources.append({'path': name, 'sha256': digest(name), 'exitCode': report['exitCode']})
processes = [line for line in subprocess.check_output(['ps', '-axo', 'pid=,comm='], text=True).splitlines() if 'flashwright-driver' in line]
profiles = list(Path(tempfile.gettempdir()).glob('flashwright-*'))
assert not processes and not profiles, (processes, profiles)
containers = subprocess.check_output(['docker', 'ps', '--format', '{{.Names}}'], text=True).splitlines()
assert len(containers) == 8 and all(name.startswith('tairox-') for name in containers), containers
cleanup_path = 'compatibility/evidence/storage-cleanup-2026-10-08.json'
save(cleanup_path, {'reports': resources, 'rootReports': len(resources), 'remainingDriverProcesses': processes, 'remainingProfiles': [], 'unrelatedContainersPreserved': containers, 'failedWatchdogs': failed_watchdogs, 'scope': 'The emulated Linux full-run timeout and its forced cleanup are retained explicitly. Other archived root watchdogs require no forced cleanup. No driver/profile remains on the native host after final checks; the owned stopped Linux containers were removed. The 029 profile residue is a watchdog-cleanup gap, not a clean-run pass.'})
checkpoint_path = 'compatibility/evidence/storage-checkpoint-2026-10-08.json'
save(checkpoint_path, {
    'status': 'Basic cookies/localStorage state pass native macOS full-core and Linux focused conformance, including native packed consumers and runner fixtures. The final full Linux run remains incomplete after a job watchdog timeout. Release and performance gates remain open.',
    'sources': sources, 'sourceCount': len(sources), 'coreEvidence': core,
    'totalCoreGroups': sum(item['checks'] for item in core), 'registryEvidence': registry, 'storageEvidence': storage,
    'node22': {'log': str(node22_log), 'logSha256': digest(node22_log), 'registry': str(node22_registry), 'registrySha256': digest(node22_registry), 'storage': str(node22_storage), 'storageSha256': digest(node22_storage), 'scope': 'Library, assertions, 29 lifecycle/protocol cases, 57 registry cases, storage differential, runner fixtures and packed library on macOS full Chromium.'},
    'change': 'Consume stale temporary-page interception cancellations without replay and preserve unrelated errors. Own visited origins at context lifetime, scope native cookies to that context, and collect/restore exact localStorage using private intercepted origin pages. Service workers are bypassed only on the internal page. Initial restoration completes before the public context is returned; uncertain cookie writes retire their owner without replay. Files are replaced atomically after complete collection.',
    'limits': {'retainedOrigins': 1024, 'snapshotUtf16UnitsIncludingTwoPerEntry': 100000, 'serializedSnapshotBytes': 7 * 1024 * 1024},
    'documentedReferenceDifference': 'SPECS S4.j: reference fallback collection may execute worker-supplied application code after public pages close; candidate collection preserves existing state without that side effect. This is reported separately from matching outcomes and is not a performance equivalence claim.',
    'diagnostics': {'path': str(exploration / 'report.json'), 'sha256': digest(exploration / 'report.json')},
    'precedingPerformanceCheckpoint': 'compatibility/evidence/evaluation-helper-performance-checkpoint-2026-10-08.json',
    'performanceRevalidationPending': True,
    'cleanup': {'path': cleanup_path, 'sha256': digest(cleanup_path)},
    'failedLinuxAttempts': failed_linux_attempts,
    'remaining': ['Complete the final full Linux matrix and fix orderly watchdog profile cleanup; the timed-out emulated run is not a pass.', 'Fix oversized outbound result handling before screenshot artifacts; the general writer currently closes the driver.', 'IndexedDB snapshots, existing-context replacement, non-HTTP origin state and cross-process child-frame collection remain explicitly unsupported.', 'Screenshot artifacts, console/pageerror, handles, broader navigation/network/runner conformance, M3 transport, native Linux, contention, platform packaging and release gates remain open.'],
    'scope': 'Native macOS arm64 Node24 headless shell on/off and full Chromium on; three focused post-fix storage corpora on emulated Linux x64 Node24; macOS Node22 focused coverage. The final full Linux core attempt did not complete. Existing timing checkpoints apply only to their recorded binaries; no storage performance claim is made.',
})
print(checkpoint_path, len(sources), core[0]['driverSha256'])
