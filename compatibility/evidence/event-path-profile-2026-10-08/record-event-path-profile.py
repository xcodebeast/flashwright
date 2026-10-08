from pathlib import Path
import datetime
import hashlib
import json


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def reference(path):
    path = Path(path)
    if path.is_absolute():
        path = path.relative_to(Path.cwd())
    return {'path': str(path), 'sha256': digest(path)}


archive = Path('compatibility/evidence/event-path-profile-2026-10-08')
report_path = Path('.cache/event-profile-native-001/core-path.txt').read_text().strip()
report = read(report_path)
assert report['status'] == 'passed' and len(report['checks']) == 35
assert not report['sourceChangedDuringVerification'] and not report['browserChangedDuringVerification']
for check in report['checks']:
    assert check['code'] == 0
    assert digest(Path(report_path).parent / check['log']) == check['logSha256']
comparisons = []
attribution = None
for entry in read(archive / 'event-path-profiles-001/attempts.json'):
    assert entry['exitCode'] == entry['verificationExitCode'] == 0
    directory = Path(entry['directory'])
    metadata = read(directory / 'metadata.json')
    summary = read(directory / 'summary.json')
    assert summary['valid']
    assert metadata['sources'] == report['sources']
    assert metadata['driver']['sha256'] == report['driverSha256']
    assert metadata['browser']['sha256'] == report['browser']['sha256']
    for name, expected in summary['retainedFileHashes'].items():
        assert digest(directory / name) == expected
    retained = {'label': entry['label'], 'directory': str(directory.relative_to(Path.cwd())),
                'metadata': reference(directory / 'metadata.json'), 'summary': reference(directory / 'summary.json'),
                'independentVerification': reference(archive / 'event-path-profiles-001' / (entry['label'] + '-verification.log'))}
    if entry['label'] == 'attribution':
        assert len(summary['launches']) == 4
        assert all(not launch['failures'] for launch in summary['launches'])
        attribution = retained
    else:
        assert summary['unexpectedFailures'] == 0 and summary['complete']
        retained.update({'completeLaunch': summary['completeLaunch'], 'workloads': summary['workloads'], 'policy': summary['policy']})
        comparisons.append(retained)
checkpoint = {
    'schemaVersion': 1,
    'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'status': 'Current default-off engine remains near parity in two complete-flow comparisons; no material improvement. All 32 ordinary and four separate instrumented launches independently verify.',
    'plan': reference('compatibility/evidence/event-path-profile-plan-2026-10-08.json'),
    'sourceCheckpoint': reference('compatibility/evidence/console-checkpoint-2026-10-08.json'),
    'verification': reference(report_path),
    'sourceCount': len(report['sources']), 'sources': report['sources'],
    'driverSha256': report['driverSha256'], 'browser': report['browser'],
    'engineConfiguration': report['engineConfiguration'],
    'comparisons': comparisons, 'attribution': attribution,
    'timeoutBoundary': {
        'probe': reference(archive / 'timeout-boundary-001/probe.mjs'),
        'results': reference(archive / 'timeout-boundary-001/results.json'),
        'summary': reference(archive / 'timeout-boundary-001/summary.json'),
        'conclusion': 'Instrumented 30-sample boundary probe places median driver round trip at 25.020ms and post-reply client plus matcher phases around 0.175ms. All command budgets were 24ms after client rounding. These wrappers perturb timing and are excluded from speed evidence. Deadline waiting dominates; no request deadline was shortened to improve the benchmark.'
    },
    'nextDecision': 'Evaluate current resident assertions with full conformance, identical-binary off/on complete flows and the unchanged sustained-load matrix before considering a default change.',
    'limitations': ['One worker, seven fixed workloads, shared native Apple M3 Pro macOS, identical Chromium headless shell revision 1223.', 'Failure medians regress in both comparisons; observed-maximum regressions are retained in each policy.', 'Protocol attribution is diagnostic, not ordinary timing evidence.', 'Native Linux, worker contention, broad migration and release performance remain open. No fastest-engine claim.'],
    'retainedArchiveFiles': [reference(path) for path in sorted(archive.rglob('*')) if path.is_file()],
}
output = Path('compatibility/evidence/event-path-profile-checkpoint-2026-10-08.json')
with output.open('x') as stream:
    stream.write(json.dumps(checkpoint, indent=2) + '\n')
print(output)
