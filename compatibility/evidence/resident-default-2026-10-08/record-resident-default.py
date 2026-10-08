from pathlib import Path
import datetime
import hashlib
import json
import shutil
import subprocess
import tempfile


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def reference(path):
    path = Path(path)
    if path.is_absolute():
        path = path.relative_to(Path.cwd())
    return {'path': str(path), 'sha256': digest(path)}


archive = Path('compatibility/evidence/resident-default-2026-10-08')
archive.mkdir()
for name in ['resident-default-native-001', 'resident-default-platforms-001', 'linux-resident-default-055', 'resident-default-profile-001']:
    shutil.copytree(Path('.cache') / name, archive / name, ignore=shutil.ignore_patterns('flashwright-driver', 'flashwright-driver-linux-x64'))
for name in ['run-resident-default-native.py', 'run-resident-default-platforms.py', 'verify-resident-default-platform.mjs', 'linux-resident-default.sh', 'run-linux-resident-default.py', 'run-resident-default-profile.py', 'record-resident-default.py']:
    shutil.copy2(Path('.cache') / name, archive / name)
core_path = Path(Path('.cache/resident-default-native-001/core-path.txt').read_text().strip())
paths = {
    'nativeDefault': core_path,
    'node22Default': archive / 'resident-default-platforms-001/node22-default/report.json',
    'nativeOff': archive / 'resident-default-platforms-001/node24-off/report.json',
    'emulatedLinuxDefault': archive / 'linux-resident-default-055/evidence/resident-default-linux/report.json',
}
reports = {label: read(path) for label, path in paths.items()}
sources = reports['nativeDefault']['sources']
for name, expected in sources.items():
    assert digest(name) == expected, name
for label, report in reports.items():
    assert report['status'] == 'passed'
    assert report['sources'] == sources
    assert not report['sourceChangedDuringVerification'] and not report['browserChangedDuringVerification']
    assert report['engineConfiguration'] == {'residentAssertions': label != 'nativeOff', 'conditionInstrumentation': False}
    if label != 'nativeDefault':
        assert not report['driverChangedDuringVerification']
        assert report['assertionSwitch'] == ('0' if label == 'nativeOff' else None)
    for check in report['checks']:
        assert check['code'] == 0
        assert digest(paths[label].parent / check['log']) == check.get('logSha256', check.get('sha256'))
assert len(reports['nativeDefault']['checks']) == 35
assert [len(reports[label]['checks']) for label in ['node22Default', 'nativeOff', 'emulatedLinuxDefault']] == [8, 4, 11]
native_driver = reports['nativeDefault']['driverSha256']
assert all(reports[label]['driverSha256'] == native_driver for label in ['node22Default', 'nativeOff'])
profile_attempt = read(archive / 'resident-default-profile-001/attempt.json')
assert profile_attempt['exitCode'] == profile_attempt['verificationExitCode'] == 0
assert profile_attempt['assertionEnvironmentSwitch'] is None
profile_directory = Path(profile_attempt['directory'])
metadata = read(profile_directory / 'metadata.json')
summary = read(profile_directory / 'summary.json')
assert summary['valid'] and summary['complete'] and summary['unexpectedFailures'] == 0
assert metadata['sources'] == sources and metadata['driver']['sha256'] == native_driver
for name, expected in summary['retainedFileHashes'].items():
    assert digest(profile_directory / name) == expected
commands = {}
for line in subprocess.check_output(['ps', '-axo', 'pid=,comm='], text=True).splitlines():
    identifier, command = line.strip().split(None, 1)
    commands[int(identifier)] = command
remaining = []
for line in subprocess.check_output(['ps', '-axo', 'pid=,args='], text=True).splitlines():
    fields = line.strip().split(None, 1)
    if len(fields) != 2:
        continue
    identifier, arguments = fields
    command = commands.get(int(identifier), '')
    if command.endswith('flashwright-driver') or ('chrome' in command.lower() and '--user-data-dir=' in arguments and 'flashwright-chromium-' in arguments):
        remaining.append({'process': int(identifier), 'command': command})
profiles = [str(path) for path in Path(tempfile.gettempdir()).glob('flashwright-chromium-*')]
containers = subprocess.check_output(['docker', '--context', 'desktop-linux', 'ps', '-a', '--format', '{{.Names}}'], text=True).splitlines()
assert not remaining and not profiles and 'flashwright-resident-default-055' not in containers
cleanup = {'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'remainingOwnedProcesses': remaining,
           'remainingProfiles': profiles, 'remainingAttemptContainers': [], 'otherContainersPreserved': containers,
           'containerAudit': reference(archive / 'linux-resident-default-055/container-audit.json')}
cleanup_path = archive / 'cleanup.json'
cleanup_path.write_text(json.dumps(cleanup, indent=2) + '\n')
checkpoint = {
    'schemaVersion': 1, 'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'status': 'Resident assertions enabled by default. All 58 current conformance groups and 16 actual-default benchmark launches independently verify; see retained policy for performance acceptance.',
    'decision': reference('compatibility/evidence/resident-adoption-profile-checkpoint-2026-10-08.json'),
    'sourceCount': len(sources), 'sources': sources, 'nativeReleaseDriverSha256': native_driver,
    'linuxDebugDriverSha256': reports['emulatedLinuxDefault']['driverSha256'],
    'verification': {label: {**reference(path), 'groups': len(reports[label]['checks']), 'engineConfiguration': reports[label]['engineConfiguration']} for label, path in paths.items()},
    'defaultCoverage': 'The three existing protocol registration/cancellation cases remove the residency environment variable even under an explicit-off surrounding run. Actual default-mode full core, Node22 and Linux checks preserve host deadlines and exact-context cleanup. The four explicit-off groups retain the comparison path.',
    'profile': {'plan': reference('compatibility/evidence/resident-default-profile-plan-2026-10-08.json'),
                'directory': str(profile_directory.relative_to(Path.cwd())), 'metadata': reference(profile_directory / 'metadata.json'),
                'summary': reference(profile_directory / 'summary.json'), 'independentVerification': reference(archive / 'resident-default-profile-001/verification.log'),
                'completeLaunch': summary['completeLaunch'], 'workloads': summary['workloads'], 'policy': summary['policy']},
    'cleanup': reference(cleanup_path),
    'limitations': ['The preceding 194-launch adoption matrix is bound to its pre-default binary; the assertion algorithm is unchanged, but its timings are not relabeled as this binary.',
                    'Final timing uses the rebuilt actual default, matching full native conformance, one worker, shared native M3 Pro macOS and identical pinned Chromium headless shell.',
                    'Linux coverage is functional x64 emulation, not native Linux timing or release acceptance.',
                    'The existing resident registry bounds each document to 128 pending conditions and returns ResourceLimitError above that fixed preview limit; complete resource-limit configuration remains open.',
                    'Full M2/M3, CBOR, broader migration, worker contention, platform acquisition and release/fastest-engine gates remain open.'],
    'retainedArchiveFiles': [reference(path) for path in sorted(archive.rglob('*')) if path.is_file()],
}
path = Path('compatibility/evidence/resident-default-checkpoint-2026-10-08.json')
with path.open('x') as output:
    output.write(json.dumps(checkpoint, indent=2) + '\n')
print(path)
