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


def verify_core(path):
    report = read(path)
    assert report['status'] == 'passed' and len(report['checks']) == 29, path
    assert not report['sourceChangedDuringVerification'] and not report['browserChangedDuringVerification'], path
    for check in report['checks']:
        assert check['code'] == 0 and digest(path.parent / check['log']) == check['logSha256'], check
    lifecycle = (path.parent / report['checks'][14]['log']).read_text()
    assert lifecycle.count('\nOK\n') == 6
    assert [int(count) for count in re.findall(r'Ran (\d+) tests', lifecycle)] == [21, 6, 10, 10, 11, 6]
    rust = (path.parent / report['checks'][2]['log']).read_text()
    assert sum(map(int, re.findall(r'test result: ok\. (\d+) passed', rust))) == 57
    return report


native_path = Path(Path('.cache/resident-core-screenshots-path.txt').read_text().strip())
native = verify_core(native_path)
linux_path = next(Path('.cache/linux-screenshots-046/evidence').glob('core-*/report.json'))
linux = verify_core(linux_path)
node22 = read('.cache/screenshots-node22-003/report.json')
sources = node22['sources']
assert len(sources) == 187 and linux['sources'] == native['sources'] == sources
for name, expected in sources.items():
    assert digest(name) == expected, name
assert native['driverSha256'] == node22['driverSha256'] == digest('.cache/screenshots-005/flashwright-driver')
assert linux['driverSha256'] == digest('.cache/linux-screenshots-046/flashwright-driver-linux-x64')
assert linux['environmentClass'] == 'local-amd64-emulation-functional-only'
assert node22['status'] == 'passed' and len(node22['checks']) == 6
assert not any(node22[key] for key in ['sourceChangedDuringVerification', 'driverChangedDuringVerification', 'browserChangedDuringVerification'])
for check in node22['checks']:
    assert check['code'] == 0 and check['sha256'] == digest(Path('.cache/screenshots-node22-003') / check['log'])
audit = read('.cache/screenshots-cleanup-audit.json')
assert not audit['remainingOwnedProcesses'] and not audit['remainingProfiles'] and not audit['remainingAttemptContainers']
assert not read('.cache/linux-screenshots-046/container-audit.json')['remainingProfiles']

# Preserve every exploratory failure and final verification log; binaries remain local.
destination = Path('compatibility/evidence/screenshots-integration-2026-10-08')
destination.mkdir()
for attempt in ['001', '002', '003', '004', '005']:
    shutil.copytree(f'.cache/screenshots-{attempt}', destination / f'native-{attempt}', ignore=shutil.ignore_patterns('flashwright-driver'))
for pattern in ['screenshot-build-*.log', 'screenshot-browser-*.log', 'screenshot-clippy-*.log']:
    for path in Path('.cache').glob(pattern):
        shutil.copy2(path, destination / path.name)
shutil.copytree('.cache/screenshots-node22-001', destination / 'node22-001')
shutil.copytree('.cache/screenshots-node22-002', destination / 'node22-002')
shutil.copytree('.cache/screenshots-node22-003', destination / 'node22-003')
shutil.copytree('.cache/linux-image-rebuild-002', destination / 'linux-image-rebuild')
shutil.copy2('.cache/Dockerfile.linux-verification', destination / 'Dockerfile.linux-verification')
shutil.copytree('.cache/linux-screenshots-046', destination / 'linux-046', ignore=shutil.ignore_patterns('flashwright-driver-linux-x64'))
for source, label in [('linux-screenshots-042', 'linux-042'), ('linux-screenshots-045', 'linux-045'), ('linux-screenshots-probe-043', 'linux-probe-043'), ('linux-screenshots-barriers-044', 'linux-barriers-044'), ('native-screenshots-trace-001', 'native-trace-001'), ('screenshots-exploration-2026-10-08', 'exploration')]:
    shutil.copytree(Path('.cache') / source, destination / label, ignore=shutil.ignore_patterns('flashwright-driver-linux-x64'))
for name in ['probe-oopif-screenshots.mjs', 'probe-oopif-barriers.mjs', 'probe-oopif-trace.mjs', 'screenshot-protocol-proxy.py', 'linux-screenshots-focused.sh', 'record-screenshots.py', 'audit-screenshots.py', 'verify-screenshots-node22.mjs', 'verify-screenshots-final-node22.mjs', 'linux-screenshots-core.sh', 'screenshots-cleanup-audit.json']:
    shutil.copy2(Path('.cache') / name, destination / name)

screenshots = []
for root in [Path('compatibility/evidence'), destination / 'linux-045/evidence', destination / 'linux-046/evidence']:
    for path in sorted(root.glob('screenshots-*/report.json')):
        report = read(path)
        if report.get('sources') != sources:
            continue
        assert report['status'] == 'passed' and not report['sourceChangedDuringVerification'], path
        assert report['outcomes']['reference'] == report['outcomes']['flashwright'], path
        assert len(report['candidateChecks']) == 4, path
        screenshots.append({**reference(path), 'browser': report['browser'], 'node': report['node'], 'imageComparisons': len(report['outcomes']['reference']['images']), 'referenceDifference': report['referenceDifferences']})
assert len(screenshots) == 5, screenshots

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
    assert max(sample['concurrentRssBytes'] for sample in report['samples']) == report['maximumSampledConcurrentRssBytes'], path
    resources.append({**reference(path), **{key: report[key] for key in ['timedOut', 'interrupted', 'exitCode', 'cleanupSignals', 'cleanup']}})

runtime_digest = hashlib.sha256()
runtime_files = Path('packages/resident-runtime/sources.txt').read_text().splitlines()
for name in runtime_files:
    data = (Path('packages/resident-runtime') / name).read_bytes()
    runtime_digest.update(len(data).to_bytes(8, 'little'))
    runtime_digest.update(data)

checkpoint = {
    'schemaVersion': 1,
    'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'scope': 'M2 page screenshot Buffer/file capture with bounded typed binary transfer and exact preparation cleanup. Native window/screen viewport conformance repair. Functional verification only; no performance or release claim.',
    'sources': sources,
    'previousCheckpoint': reference('compatibility/evidence/browser-payload-checkpoint-2026-10-08.json'),
    'provenance': reference('compatibility/upstream/screenshot-provenance.json'),
    'contract': {
        'applicationProtocol': 5, 'residentRuntimeSha256': runtime_digest.hexdigest(), 'residentRuntimeFiles': runtime_files,
        'maximumDimensionPixels': 32767, 'maximumOutputPixels': 16777216,
        'maximumDecodedAttachmentBytes': 32 * 1024 * 1024,
        'defaults': 'PNG or case-sensitive path inference; hidden caret, allowed animations, device scale, JPEG quality 80 and main-document font readiness.',
        'ownership': 'Per-page queue retains independent caller deadlines. Temporary styles/caret/animation restoration owns opaque objects in exactly the prepared realms. Read-only geometry follows navigation without replaying preparation. Uncertain restoration retires the affected page and preserves the original error. Atomic files replace only after complete successful capture.',
        'childRendererDependency': 'Unmodified captures retain the reference child-renderer evaluation dependency through temporary owned target sessions. A blocked child times out, detaches its session and leaves the parent usable. Load is not a first-paint guarantee in either engine; the differential fixture establishes child and parent rendering readiness before comparing pixels. Production capture adds no sleep or animation-frame delay.',
        'viewportRepair': 'Match pinned native window bounds and desktop/headless insets, emulated screen dimensions and orientation. The previous setup omitted these and produced different natural viewport/OOPIF pixels; earlier performance evidence does not apply to this build.',
        'intentionalDifference': 'SPECS S4.k: an expired queued capture never prepares later. The pinned reference can leave its late temporary style behind. Recorded separately from shared image equality.',
    },
    'coverage': [
        'PNG/JPEG decoded-pixel and dimension comparison; viewport, full-page, fractional and negative clips, scrolling, alpha, quality, scale, inferred/explicit file types and natural viewport.',
        'Font wait and timeout, exact caret style/priority restoration in document/shadow/child frames, finite/infinite animation semantics, navigation during fonts, closure, queue expiry and sibling survival after blocked-renderer retirement.',
        'A 12,624,074-byte noisy PNG exceeds the ordinary 8 MiB CDP reply bound. Raw tests exercise 32 KiB application framing, negotiated payload limits, cancellation mid-stream and successor reuse.',
        'Invalid/unsupported options and timed-out captures preserve existing files. Unmodified cross-process frames match reference pixels; unsupported preparation rejects before DOM mutation.',
    ],
    'verification': {
        'nativeCore': {**reference(native_path), 'groups': 29, 'rustTests': 57, 'lifecycleCases': 64, 'driverSha256': native['driverSha256']},
        'node22': {**reference(destination / 'node22-003/report.json'), 'groups': 6},
        'linuxCore': {**reference(destination / 'linux-046/evidence' / linux_path.parent.name / 'report.json'), 'groups': 29, 'rustTests': 57, 'lifecycleCases': 64, 'driverSha256': linux['driverSha256'], 'environmentClass': linux['environmentClass'], 'containerImage': linux['containerImage']},
        'screenshots': screenshots,
        'resourcesIndependentlyRecomputed': len(resources),
    },
    'environmentRecovery': 'The local Linux verification image was absent at read-only inspection. Rebuilt the saved pinned recipe before attempt 042; its unchanged rebuilt image was reused for final attempt 046 and recorded its resulting identity. The outer complete-suite budget was declared as 1800 seconds for the expanded 29-group corpus; individual test/module and public API deadlines were unchanged.',
    'exploration': 'All exploratory logs and reports are retained. Failures exposed uppercase path inference, an unhandled fixture promise, the pinned expired-queue style leak, an unsupported fixture FontFace result and omitted native window metrics. A test-only headless initializer prevented Rust test compilation and was corrected. Attempt 008 originally passed its weaker navigation-restoration property, but review found a reference-success/candidate-error mismatch; broad native attempt 003 was intentionally interrupted before edits. The implementation now follows current geometry while retaining original cleanup, and the final fixture requires successful pixel-equal viewport/full-page captures after navigation during font waits. The first Node22 run passed five groups but failed the assumed out-of-process topology; both its failure and the revised distribution-aware fixture are retained. Linux 042 passed 28 groups but failed a first-paint image comparison. Probes 043/044 and native trace 001 showed that both engines can capture before child compositing, so the fixture now waits for application rendering readiness. An independently required child-renderer dependency now owns temporary sessions across cancellation, verified by a shared blocked-child timeout/recovery case. Its first direct-message busy-loop setup hung in the reference and was interrupted; the load-then-message fault passes on both engines. Focused Linux 045 and the final full matrix validate the final implementation. See the retained exploration assessment and raw traces; none are performance evidence.',
    'exploratoryScreenshotReports': [reference(path) for path in sorted(Path('compatibility/evidence').glob('screenshots-*/report.json')) if read(path).get('sources') != sources],
    'interruptedNativeCore': {'directory': 'compatibility/evidence/core-darwin-arm64-24.15.0-2026-10-08T13-36-29.362Z', 'metadata': reference(destination / 'native-003/interruption.json')},
    'resources': resources,
    'artifacts': {str(path): digest(path) for path in sorted(destination.rglob('*')) if path.is_file()},
    'remaining': ['Screenshot masks, element capture, comparison assertions, runner artifact policies and cross-process preparation.', 'Other M2 APIs including console/pageerror, handles, broad frames/navigation and runner behavior.', 'Native Linux, platform packages, installation/aliases, contention and release acceptance.', 'New performance evidence for this binary; older measurements remain bound to their recorded executables.'],
}
with Path('compatibility/evidence/screenshots-checkpoint-2026-10-08.json').open('x') as output:
    json.dump(checkpoint, output, indent=2)
    output.write('\n')
print(f'Recorded 58 core groups, six Node22 groups and {len(resources)} independently recomputed resource reports.')
