from pathlib import Path
import datetime
import hashlib
import json
import shutil


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def reference(path):
    path = Path(path)
    if path.is_absolute():
        path = path.relative_to(Path.cwd())
    return {'path': str(path), 'sha256': digest(path)}


archive = Path('compatibility/evidence/resident-adoption-profile-2026-10-08')
archive.mkdir()
for name in ['resident-adoption-native-001', 'resident-adoption-profiles-001']:
    shutil.copytree(Path('.cache') / name, archive / name, ignore=shutil.ignore_patterns('flashwright-driver'))
for name in ['run-resident-adoption-native.py', 'run-resident-adoption-profiles.py', 'record-resident-adoption-profile.py']:
    shutil.copy2(Path('.cache') / name, archive / name)
reports = {}
for mode, name in [('off', 'event-profile-native-001'), ('on', 'resident-adoption-native-001')]:
    path = Path(Path('.cache', name, 'core-path.txt').read_text().strip())
    report = read(path)
    assert report['status'] == 'passed' and len(report['checks']) == 35
    assert report['engineConfiguration'] == {'residentAssertions': mode == 'on', 'conditionInstrumentation': False}
    assert not report['sourceChangedDuringVerification'] and not report['browserChangedDuringVerification']
    for check in report['checks']:
        assert check['code'] == 0 and digest(path.parent / check['log']) == check['logSha256']
    reports[mode] = {'reference': reference(path), 'report': report}
assert reports['off']['report']['sources'] == reports['on']['report']['sources']
assert reports['off']['report']['driverSha256'] == reports['on']['report']['driverSha256']
assert reports['off']['report']['browser'] == reports['on']['report']['browser']
entries = read(archive / 'resident-adoption-profiles-001/attempts.json')
assert len(entries) == 3
retained = {}
summaries = {}
for entry in entries:
    assert entry['exitCode'] == entry['verificationExitCode'] == 0
    directory = Path(entry['directory'])
    metadata = read(directory / 'metadata.json')
    summary = read(directory / 'summary.json')
    assert summary['valid'] and summary['complete'] and summary['unexpectedFailures'] == 0
    for field in ['sourceChangedDuringTiming', 'driverChangedDuringTiming', 'browserChangedDuringTiming']:
        assert not summary[field]
    assert metadata['sources'] == reports['on']['report']['sources']
    assert metadata['driver']['sha256'] == reports['on']['report']['driverSha256']
    for name, expected in summary['retainedFileHashes'].items():
        assert digest(directory / name) == expected
    summaries[entry['label']] = summary
    retained[entry['label']] = {
        'directory': str(directory.relative_to(Path.cwd())),
        'metadata': reference(directory / 'metadata.json'), 'summary': reference(directory / 'summary.json'),
        'independentVerification': reference(archive / 'resident-adoption-profiles-001' / (entry['label'] + '-verification.log')),
    }
    if entry['label'] != 'load':
        retained[entry['label']].update({field: summary[field] for field in ['completeLaunch', 'processWall', 'workloads']})
        if 'policy' in summary:
            retained[entry['label']]['policy'] = summary['policy']
load_gates = []
for scenario in summaries['load']['scenarios']:
    for comparison in scenario['comparisons']:
        if comparison['candidateMode'] != 'flashwright-on':
            continue
        load_gates.append({
            'scenario': scenario['scenario'], 'referenceMode': comparison['referenceMode'],
            'gate': comparison['gate'], 'passed': comparison['passed'],
            'ratios': {name: {'medianReferenceOverCandidate': metric['medianReferenceOverCandidate'], 'confidenceInterval': metric['confidenceInterval']}
                       for name, metric in comparison['metrics'].items()},
        })
assert len(load_gates) == 18
benefit = all(summaries[label]['completeLaunch']['pairedSpeedupConfidenceInterval'][0] > 1 for label in ['playwright', 'off-on'])
passed = benefit and all(entry['passed'] for entry in load_gates)
checkpoint = {
    'schemaVersion': 1, 'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'status': 'All 194 production launches independently verify. Adoption criteria ' + ('pass.' if passed else 'remain unmet.'),
    'plan': reference('compatibility/evidence/resident-adoption-plan-2026-10-08.json'),
    'defaultBaseline': reference('compatibility/evidence/event-path-profile-checkpoint-2026-10-08.json'),
    'verification': {mode: entry['reference'] for mode, entry in reports.items()},
    'coreGroups': 70, 'sourceCount': len(reports['on']['report']['sources']), 'sources': reports['on']['report']['sources'],
    'driverSha256': reports['on']['report']['driverSha256'], 'browser': reports['on']['report']['browser'],
    'comparisons': retained, 'residentLoadGates': load_gates,
    'adoptionCriteriaPassed': passed,
    'decisionScope': 'Decision about enabling the existing supported assertion path. A passing decision does not satisfy the separate 10% complete-flow release target or erase workload regressions. A source change of default still needs verification.',
    'limitations': ['Shared native Apple M3 Pro macOS, one worker, matched pinned headless shell and artifacts off.',
                    'Eight pairs per complete-flow comparison and six groups per load scenario; confidence intervals and observed maxima are retained, not percentile tails.',
                    'The Playwright comparison retains failure median and navigation observed-maximum regressions.',
                    'The identical-binary navigation median ratio is 0.9495 with a confidence interval spanning parity; the point estimate exceeds 5% growth and is retained for review.',
                    'Native Linux throughput, contention, broad migration, platform packages and release acceptance remain open. No fastest-engine claim.'],
    'retainedArchiveFiles': [reference(path) for path in sorted(archive.rglob('*')) if path.is_file()],
}
output = Path('compatibility/evidence/resident-adoption-profile-checkpoint-2026-10-08.json')
with output.open('x') as stream:
    stream.write(json.dumps(checkpoint, indent=2) + '\n')
print(output, 'adoptionCriteriaPassed=', passed)
for entry in load_gates:
    print(entry['scenario'], entry['referenceMode'], entry['passed'], entry['gate'])
