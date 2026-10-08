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
    assert report['status'] == 'passed' and len(report['checks']) == 27, path
    assert not report['sourceChangedDuringVerification'] and not report['browserChangedDuringVerification'], path
    for check in report['checks']:
        assert check['code'] == 0 and digest(path.parent / check['log']) == check['logSha256'], check
    lifecycle = (path.parent / report['checks'][13]['log']).read_text()
    assert lifecycle.count('\nOK\n') == 6
    assert [int(count) for count in re.findall(r'Ran (\d+) tests', lifecycle)] == [21, 6, 10, 10, 8, 6]
    return report


native_path = Path(Path('.cache/resident-core-browser-payload-path.txt').read_text().strip())
native = verify_core(native_path)
linux_path = next(Path('.cache/linux-browser-payload-041/evidence').glob('core-*/report.json'))
linux = verify_core(linux_path)
node22 = read('.cache/browser-payload-node22/report.json')
sources = native['sources']
assert len(sources) == 179 and linux['sources'] == node22['sources'] == sources
for name, expected in sources.items():
    assert digest(name) == expected, name
assert native['driverSha256'] == node22['driverSha256'] == digest('.cache/browser-payload-002/flashwright-driver')
assert linux['driverSha256'] == digest('.cache/linux-browser-payload-041/flashwright-driver-linux-x64')
assert linux['environmentClass'] == 'local-amd64-emulation-functional-only'
assert node22['status'] == 'passed' and len(node22['checks']) == 4
assert not any(node22[key] for key in ['sourceChangedDuringVerification', 'driverChangedDuringVerification', 'browserChangedDuringVerification'])
for check in node22['checks']:
    assert check['code'] == 0 and check['sha256'] == digest(Path('.cache/browser-payload-node22') / check['log'])
audit = read('.cache/browser-payload-cleanup-audit.json')
assert not audit['remainingOwnedProcesses'] and not audit['remainingProfiles'] and not audit['remainingAttemptContainers']
assert not read('.cache/linux-browser-payload-041/container-audit.json')['remainingProfiles']

# Freeze scratch logs and reports without copying executable artifacts into Git.
destination = Path('compatibility/evidence/browser-payload-integration-2026-10-08')
destination.mkdir()
for attempt in ['001', '002']:
    shutil.copytree(f'.cache/browser-payload-{attempt}', destination / f'native-{attempt}', ignore=shutil.ignore_patterns('flashwright-driver'))
shutil.copytree('.cache/browser-payload-node22', destination / 'node22')
shutil.copytree('.cache/linux-browser-payload-040', destination / 'linux-040-launch-failure')
shutil.copytree('.cache/linux-image-rebuild-001', destination / 'linux-image-rebuild')
shutil.copy2('.cache/Dockerfile.linux-verification', destination / 'Dockerfile.linux-verification')
shutil.copytree('.cache/linux-browser-payload-041', destination / 'linux-041', ignore=shutil.ignore_patterns('flashwright-driver-linux-x64'))
for name in ['record-browser-payload.py', 'audit-browser-payload.py', 'verify-browser-payload-node22.mjs', 'linux-lifecycle-budget-core.sh', 'browser-payload-cleanup-audit.json']:
    shutil.copy2(Path('.cache') / name, destination / name)

resources = []
native_resources = [Path(name) for name in subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', 'compatibility/evidence/resources'], text=True).splitlines()]
for path in [*native_resources, *destination.glob('native-*/resources/*.json'), *destination.glob('linux-041/evidence/resources/*.json')]:
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

checkpoint = {
    'schemaVersion': 1,
    'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'scope': 'Bounded typed response bodies across the Chromium JSON boundary, preserving ordinary control limits and originating closure errors. Functional conformance only; no performance or release claim.',
    'sources': sources,
    'previousCheckpoint': reference('compatibility/evidence/lifecycle-budget-checkpoint-2026-10-08.json'),
    'contract': {
        'applicationProtocol': 5, 'ordinaryControlBytes': 8 * 1024 * 1024,
        'maximumDecodedAttachmentBytes': 32 * 1024 * 1024,
        'maximumIncomingWireBytes': 6 * 32 * 1024 * 1024 + 65536,
        'retainedReceiveBufferBytes': 65536,
        'behavior': 'Typed body replies use borrowed raw envelopes and known-shape decoding; the negotiated decoded cap is validated before copying borrowed bytes. Complete oversized ordinary replies reject only their call. Oversized events or the hard wire cap invalidate the connection. Late cancelled replies do not build result values. Page/context invalidation retains the originating transport failure. Large receive buffers are released after each frame.',
        'limitation': 'The Chromium JSON frame is still buffered up to the hard wire bound and escaped strings require decoded storage. This is not a constant-memory or streaming CDP decoder. Application attachment frames remain bounded and backpressured.',
    },
    'coverage': [
        'Rust tests cover a 9 MiB admitted body with reordered envelope fields, oversized ordinary replies, cancellation midway through a large frame followed by a successful command, fatal oversized events, bounded allocation/release and exact escaped/base64 decoding.',
        'Eight raw real-browser cases include a 9 MiB all-byte binary body and 2 MiB NUL text whose JSON wire representation exceeds 12 MiB, exact data through 32 KiB application frames, negotiated-limit rejection, cancellation, successor reuse and original-error cleanup.',
        'Public TypeScript navigation differentials compare both large bodies byte-for-byte with pinned Playwright and assert exactly one HTTP request per body.',
    ],
    'verification': {
        'nativeCore': {**reference(native_path), 'groups': 27, 'lifecycleCases': 61, 'driverSha256': native['driverSha256']},
        'node22': {**reference(destination / 'node22/report.json'), 'groups': 4},
        'linuxCore': {**reference(destination / 'linux-041/evidence' / linux_path.parent.name / 'report.json'), 'groups': 27, 'lifecycleCases': 61, 'driverSha256': linux['driverSha256'], 'environmentClass': linux['environmentClass'], 'containerImage': linux['containerImage']},
        'resourcesIndependentlyRecomputed': len(resources),
    },
    'environmentRecovery': 'Linux attempt 040 exited 125 before creating a container because the local verification image was absent. Rebuilding the saved recipe reused cached layers from the pinned Playwright base and Rust 1.98 toolchain, with a newly recorded image identity. Attempt 041 is a separate full verification run; the failed launch and rebuild logs are retained.',
    'exploration': 'Native attempt 001 passed its initial Rust/browser cases before the subsequent closure-cause propagation change. Attempt 002 and the current full matrix bind the final sources. The initial driver is retained locally with its separate hash; its preliminary evidence is not a final-binary verification.',
    'resources': resources,
    'artifacts': {str(path): digest(path) for path in sorted(destination.rglob('*')) if path.is_file()},
    'remaining': ['M2 screenshots and remaining API/runner semantics.', 'Native Linux, platform packages, installation/aliases, contention and release acceptance.', 'New performance evidence for this binary; older measurements remain bound to their recorded executables.'],
}
with Path('compatibility/evidence/browser-payload-checkpoint-2026-10-08.json').open('x') as output:
    json.dump(checkpoint, output, indent=2)
    output.write('\n')
print(f'Recorded 54 core groups, four Node22 groups and {len(resources)} independently recomputed resource reports.')
