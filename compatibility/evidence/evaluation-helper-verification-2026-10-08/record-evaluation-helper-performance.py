import collections
import hashlib
import json
from pathlib import Path
import re
import shutil
import statistics
import subprocess
import tempfile


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    with Path(path).open('x') as output:
        output.write(json.dumps(value, indent=2) + '\n')


def relative(path):
    path = Path(path)
    return str(path.relative_to(Path.cwd())) if path.is_absolute() else str(path)


labels = ['off-first', 'off-replication', 'on-first', 'on-replication', 'attribution']
directories = {label: Path(Path('.cache/evaluation-helper-' + label + '-path.txt').read_text().strip()) for label in labels}
metadata = {label: read(path / 'metadata.json') for label, path in directories.items()}
summaries = {label: read(path / 'summary.json') for label, path in directories.items()}
conformance_path = 'compatibility/evidence/evaluation-helper-checkpoint-2026-10-08.json'
conformance = read(conformance_path)
sources = conformance['sources']
for path, expected in sources.items():
    assert digest(path) == expected, path
for label in labels:
    summary = summaries[label]
    assert summary['valid']
    if label == 'attribution':
        assert summary['sourcesUnchanged'] and summary['driverUnchanged'] and summary['browserUnchanged']
        assert len(summary['launches']) == 4 and all(not launch['failures'] for launch in summary['launches'])
    else:
        assert summary['complete'] and summary['unexpectedFailures'] == 0
        assert all(not summary[field] for field in ['sourceChangedDuringTiming', 'driverChangedDuringTiming', 'browserChangedDuringTiming'])
    assert metadata[label]['sources'] == sources
    assert metadata[label]['driver']['sha256'] == conformance['coreEvidence'][0]['driverSha256']
    assert metadata[label]['browser']['sha256'] == metadata['off-first']['browser']['sha256']
    for name, expected in summary['retainedFileHashes'].items():
        assert digest(directories[label] / name) == expected, name


def retained(label):
    directory = directories[label]
    return {'directory': relative(directory), 'metadataSha256': digest(directory / 'metadata.json'), 'summarySha256': digest(directory / 'summary.json'), 'valid': True}


def comparison(label):
    summary = summaries[label]
    return {**retained(label), 'label': label, 'mode': 'off' if label.startswith('off-') else 'on', 'independentPairs': 8, 'unexpectedFailures': summary['unexpectedFailures'], 'completeLaunch': summary['completeLaunch'], 'workloads': summary['workloads'], 'policy': summary['policy']}


evaluation_source = Path('crates/flashwright-engine/src/evaluation.rs').read_text()
expression_template = json.loads(re.search(r'let expression = format!\(\s*("(?:[^"\\]|\\.)*")', evaluation_source).group(1))
expression = expression_template.replace('{{', '{').replace('}}', '}').replace('{VALUE_CODEC}', Path('packages/resident-runtime/serialization.cjs').read_text()).replace('{EVALUATION_RUNTIME}', Path('packages/resident-runtime/evaluation.cjs').read_text())
callback = json.loads(re.search(r'"functionDeclaration":\s*("(?:[^"\\]|\\.)*")', evaluation_source).group(1))
script_hash = lambda source: hashlib.sha256(source.encode('utf-16-le')).hexdigest()
protocol = []
for directory in sorted(directories['attribution'].glob('trace-*-flashwright')):
    files = list(directory.glob('protocol-*.jsonl'))
    assert len(files) == 1
    records = [json.loads(line) for line in files[0].read_text().splitlines()]
    prepared = [record for record in records if record.get('method') == 'Runtime.evaluate' and record.get('scriptSha256') == script_hash(expression)]
    callbacks = [record for record in records if record.get('method') == 'Runtime.callFunctionOn' and record.get('scriptSha256') == script_hash(callback)]
    assert len(prepared) == 6 and len(callbacks) == 81, (len(prepared), len(callbacks))
    assert len(set(record['sessionId'] for record in prepared)) == 6
    assert {record['sessionId'] for record in callbacks} == {record['sessionId'] for record in prepared}
    assert sorted(collections.Counter(record['sessionId'] for record in callbacks).values()) == [1, 1, 16, 16, 16, 31]
    assert all(record['scriptUtf16Units'] == len(expression.encode('utf-16-le')) // 2 for record in prepared)
    assert all(record['scriptUtf16Units'] == len(callback.encode('utf-16-le')) // 2 for record in callbacks)
    protocol.append({'path': relative(files[0]), 'sha256': digest(files[0]), 'helperInstallations': len(prepared), 'distinctPageSessions': 6, 'userCallbacks': len(callbacks), 'callbacksPerPage': sorted(collections.Counter(record['sessionId'] for record in callbacks).values()), 'helperSourceUtf16Units': len(expression.encode('utf-16-le')) // 2, 'callbackSourceUtf16Units': len(callback.encode('utf-16-le')) // 2, 'forwardedHelperCommandBytes': sum(record['bytes'] for record in prepared), 'forwardedCallbackCommandBytes': sum(record['bytes'] for record in callbacks), 'medianCallbackCommandBytes': statistics.median(record['bytes'] for record in callbacks)})
assert len(protocol) == 2

resources = []
ordinary_paths = [path for label, directory in directories.items() if label != 'attribution' for path in directory.rglob('resources-*.json')]
instrumented_paths = list(directories['attribution'].rglob('resources-*.json'))
assert len(ordinary_paths) == 64 and len(instrumented_paths) == 4
for path in ordinary_paths + instrumented_paths:
    report = read(path)
    assert report['exitCode'] == 0 and not report['timedOut'] and not report['interrupted'] and not report['cleanupSignals'] and not report['remainingObservedProcesses'], path
    resources.append({'path': relative(path), 'sha256': digest(path), 'exitCode': report['exitCode']})
processes = [line for line in subprocess.check_output(['ps', '-axo', 'pid=,comm='], text=True).splitlines() if 'flashwright-driver' in line]
profiles = list(Path(tempfile.gettempdir()).glob('flashwright-*'))
assert not processes and not profiles, (processes, profiles)
containers = subprocess.check_output(['docker', 'ps', '--format', '{{.Names}}'], text=True).splitlines()
assert len(containers) == 8 and all(name.startswith('tairox-') for name in containers), containers
cleanup_path = 'compatibility/evidence/evaluation-helper-performance-cleanup-2026-10-08.json'
save(cleanup_path, {'ordinaryReports': len(ordinary_paths), 'instrumentedReports': len(instrumented_paths), 'reports': resources, 'remainingDriverProcesses': [], 'remainingProfiles': [], 'unrelatedContainersPreserved': containers})
verification_directory = Path('compatibility/evidence/evaluation-helper-verification-2026-10-08')
verification_directory.mkdir()
shutil.copy2(__file__, verification_directory / Path(__file__).name)
verification = []
for label in labels:
    source = Path('.cache/evaluation-helper-' + label + '-verification.log')
    target = verification_directory / source.name
    shutil.copy2(source, target)
    verification.append({'label': label, 'log': str(target), 'sha256': digest(target)})
checkpoint_path = 'compatibility/evidence/evaluation-helper-performance-checkpoint-2026-10-08.json'
save(checkpoint_path, {
    'status': 'All 64 ordinary launches and four separate instrumented launches independently verify. See the retained policies for improvement and regression acceptance.',
    'sources': sources, 'sourceCount': len(sources), 'productionDriverSha256': metadata['off-first']['driver']['sha256'],
    'conformance': {'path': conformance_path, 'sha256': digest(conformance_path), 'coreGroups': 104},
    'host': {key: metadata['off-first'][key] for key in ['platform', 'architecture', 'cpu', 'node', 'operatingSystem', 'release', 'logicalProcessors', 'totalMemoryBytes']},
    'browser': {key: value for key, value in metadata['off-first']['browser'].items() if key != 'launchPolicy'},
    'playwrightComparisons': [comparison(label) for label in labels if label != 'attribution'],
    'attribution': {**retained('attribution'), 'launches': summaries['attribution']['launches'], 'evaluationHelperAccounting': protocol, 'scope': 'Payload-free proxy records count exact forwarded bytes and script identities. Six private helper installations serve 81 user evaluations per Flashwright launch. Instrumentation changes timing and resource costs; these observations are not ordinary speed or CPU claims.'},
    'independentVerification': verification,
    'checkpointRecorder': {'path': str(verification_directory / Path(__file__).name), 'sha256': digest(__file__)},
    'plan': {'path': 'compatibility/evidence/evaluation-helper-profile-plan-2026-10-08.json', 'sha256': digest('compatibility/evidence/evaluation-helper-profile-plan-2026-10-08.json'), 'completed': True},
    'cleanup': {'path': cleanup_path, 'sha256': digest(cleanup_path)},
    'limitations': ['One worker, seven fixed workloads, native shared Apple M3 Pro macOS host and identical pinned Chromium headless shell.', 'Eight independent pairs per comparison support bootstrap intervals and observed maxima, not percentile tails.', 'Complete time includes cold launch, helper preparation, application work and cleanup. The four instrumented launches are excluded from ordinary comparisons.', 'These comparisons are between each current mode and Playwright. Historical driver revisions do not establish a causal before/after result.', 'The older sustained-load CPU/memory matrix remains evidence for its own binary. It is not refreshed by these complete-flow comparisons.', 'Native Linux performance, contention, broad migration coverage, platform installation and release gates remain open.'],
})
print(checkpoint_path)
for label in labels[:-1]:
    print(label, summaries[label]['completeLaunch']['medianPairedSpeedup'], summaries[label]['policy'])
