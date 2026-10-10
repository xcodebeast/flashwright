"""Reproduce eight failure-rejection checks using private copies of retained traces."""

import argparse
import hashlib
import json
from pathlib import Path
import platform
import sys
import tempfile
import zipfile


EXPECTED_VERIFIER_SHA256 = 'b05b1d2cbbfe7c50e1fd54dd87792f94b448c440428fc9b70cf755568456f5dd'


def sha256(content):
    return hashlib.sha256(content).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def find_frame_call(events):
    return next(event for event in events if event['type'] == 'before'
                and 'internal:control=enter-frame' in (event.get('params', {}).get('selector') or ''))


def remove_after_event(entries, events):
    event_index = next(index for index, event in enumerate(events) if event['type'] == 'after')
    removed = events.pop(event_index)
    return 'reference: unpaired calls', {'removedAfterCallId': removed['callId']}


def change_snapshot_call(entries, events):
    call = find_frame_call(events)
    snapshot = next(event['snapshot'] for event in events if event['type'] == 'frame-snapshot'
                    and event['snapshot']['snapshotName'] == call['beforeSnapshot'])
    snapshot['callId'] = 'wrong-call'
    return f'{call["beforeSnapshot"]}: snapshot belongs to another call', {
        'snapshotName': call['beforeSnapshot'], 'replacementCallId': 'wrong-call',
    }


def invalidate_backreference(entries, events):
    snapshot = next(event['snapshot'] for event in events if event['type'] == 'frame-snapshot')
    snapshot['html'] = [[999999, 0]]
    frame_key = (snapshot['pageId'], snapshot['frameId'])
    return f'Invalid snapshot backreference in {frame_key}', {
        'snapshotName': snapshot['snapshotName'], 'replacementHtml': [[999999, 0]],
    }


def mark_main_frame_target(entries, events):
    input_event = next(event for event in events if event['type'] == 'input')
    snapshot = next(event['snapshot'] for event in events if event['type'] == 'frame-snapshot'
                    and event['snapshot']['snapshotName'] == input_event['inputSnapshot']
                    and event['snapshot'].get('isMainFrame'))
    require(isinstance(snapshot['html'][0], str), 'Chosen main snapshot must have an explicit root')
    snapshot['html'][1]['__playwright_target__'] = input_event['callId']
    return f'{input_event["callId"]}: target marked in main frame', {
        'snapshotName': snapshot['snapshotName'], 'markedRootCallId': input_event['callId'],
        'preservesPostorderNodeIndices': True,
    }


def change_source_artifact(entries, events):
    source_name = next(name for name in entries if name.startswith('resources/src@'))
    entries[source_name] += b'\nchanged source'
    return f'{source_name}: fixture source differs from report', {'sourceEntry': source_name}


def remove_filmstrip_resource(entries, events):
    frame = next(event for event in events if event['type'] == 'screencast-frame')
    resource_name = 'resources/' + frame['sha1']
    del entries[resource_name]
    return f'Missing filmstrip resource: {resource_name}', {'removedResourceEntry': resource_name}


def remove_snapshot_name(entries, events, phase):
    call = next(event for event in events if event['type'] == 'before' and event['method'] == 'click'
                and '#first' in (event.get('params', {}).get('selector') or ''))
    event = call if phase == 'before' else next(
        event for event in events if event['type'] == 'after' and event['callId'] == call['callId'])
    removed_name = event.pop(phase + 'Snapshot')
    return f'{call["callId"]}: missing {phase} snapshot name', {
        'callId': call['callId'], 'removedField': phase + 'Snapshot', 'removedValue': removed_name,
    }


def check_rejection(verifier, original_entries, original_report, engine, mutation, temporary_root):
    """Mutate one private archive; require the specific intended rejection."""
    entries = original_entries.copy()
    trace_name = next(name for name in entries if name.endswith('.trace'))
    events = [json.loads(line) for line in entries[trace_name].splitlines()]
    expected_diagnostic, mutation_details = mutation(entries, events)
    entries[trace_name] = b''.join(json.dumps(event).encode() + b'\n' for event in events)
    with tempfile.TemporaryDirectory(prefix='trace-corruption-', dir=temporary_root) as temporary:
        directory = Path(temporary)
        archive_path = directory / f'{engine}.zip'
        with zipfile.ZipFile(archive_path, 'w') as archive:
            for name, content in entries.items():
                entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                archive.writestr(entry, content)
        mutated_hash = sha256(archive_path.read_bytes())
        report = json.loads(json.dumps(original_report))
        # Replace only the private copy's hash so the intended semantic gate is
        # reached instead of stopping at the archive-integrity admission check.
        report['traces'][engine]['sha256'] = mutated_hash
        try:
            evidence = verifier['review_archive'](directory, engine, report)
            diagnostics = evidence['failures']
        except ValueError as error:
            diagnostics = [str(error)]
        require(expected_diagnostic in diagnostics,
                f'Expected rejection {expected_diagnostic!r}, observed {diagnostics!r}')
        return {'status': 'rejected', 'mutation': mutation_details,
                'expectedDiagnostic': expected_diagnostic, 'diagnostics': diagnostics,
                'mutatedArchiveSha256': mutated_hash,
                'mutatedTraceSha256': sha256(entries[trace_name])}


def main():
    repository = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verifier', type=Path, default=repository / 'tools/verify-frame-locator-traces.py')
    parser.add_argument('--evidence-directory', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--output', type=Path)
    arguments = parser.parse_args()
    verifier_bytes = arguments.verifier.read_bytes()
    require(sha256(verifier_bytes) == EXPECTED_VERIFIER_SHA256, 'Frozen verifier hash differs')
    verifier = {'__name__': 'private_trace_verifier'}
    exec(compile(verifier_bytes, str(arguments.verifier), 'exec'), verifier)
    original_checks_path = arguments.evidence_directory / 'trace-verifier-corruption-checks.json'
    original_checks_hash = sha256(original_checks_path.read_bytes())
    input_paths = {}
    datasets = {}
    for name, engine in [('differential-003', 'reference'), ('differential-004', 'flashwright')]:
        directory = arguments.evidence_directory / name
        report_path = directory / 'report.json'
        archive_path = directory / f'{engine}.zip'
        report = json.loads(report_path.read_text())
        archive_hash = sha256(archive_path.read_bytes())
        require(archive_hash == report['traces'][engine]['sha256'], 'Original trace/report hash mismatch')
        baseline = verifier['review_archive'](directory, engine, report)
        require(not baseline['failures'], f'Original {name}/{engine} baseline has verifier failures')
        with zipfile.ZipFile(archive_path) as archive:
            entries = {entry: archive.read(entry) for entry in archive.namelist()}
        datasets[name] = (engine, entries, report)
        input_paths[report_path] = sha256(report_path.read_bytes())
        input_paths[archive_path] = archive_hash
    checks = [
        ('unpaired-call', 'differential-003', remove_after_event),
        ('wrong-snapshot-call', 'differential-003', change_snapshot_call),
        ('invalid-backreference', 'differential-003', invalidate_backreference),
        ('main-frame-input-target', 'differential-003', mark_main_frame_target),
        ('changed-source-artifact', 'differential-003', change_source_artifact),
        ('missing-filmstrip-resource', 'differential-003', remove_filmstrip_resource),
        ('missing-candidate-before-snapshot-name', 'differential-004',
         lambda entries, events: remove_snapshot_name(entries, events, 'before')),
        ('missing-candidate-after-snapshot-name', 'differential-004',
         lambda entries, events: remove_snapshot_name(entries, events, 'after')),
    ]
    result = {
        'schemaVersion': 1, 'status': 'passed',
        'scope': 'Eight deliberate-corruption failure-rejection checks only; no browser execution, '
                 'build, production mutation, visual-fidelity or full trace-parity claim.',
        'script': {'name': Path(__file__).name, 'sha256': sha256(Path(__file__).read_bytes())},
        'verifier': {'name': arguments.verifier.name, 'sha256': sha256(verifier_bytes)},
        'runtime': {'pythonVersion': platform.python_version(), 'implementation': platform.python_implementation(),
                    'versionOutput': sys.version, 'executable': sys.executable},
        'originalChecksSha256': original_checks_hash,
        'rawInputs': {str(path.relative_to(arguments.evidence_directory)): digest
                      for path, digest in input_paths.items()},
        'checks': [],
    }
    for name, dataset, mutation in checks:
        engine, entries, report = datasets[dataset]
        evidence = check_rejection(verifier, entries, report, engine, mutation, arguments.evidence_directory)
        result['checks'].append({'name': name, 'dataset': dataset, 'engine': engine, **evidence})
    require(all(sha256(path.read_bytes()) == digest for path, digest in input_paths.items()),
            'Retained raw input changed during checks')
    require(sha256(arguments.verifier.read_bytes()) == EXPECTED_VERIFIER_SHA256,
            'Frozen verifier changed during checks')
    require(sha256(original_checks_path.read_bytes()) == original_checks_hash,
            'Original corruption checks changed during confirmation')
    result['rawInputsUnchanged'] = True
    result['verifierUnchanged'] = True
    result['originalChecksUnchanged'] = True
    output = arguments.output or arguments.evidence_directory / 'trace-verifier-corruption-confirmation.json'
    output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'checks': len(result['checks']), 'output': str(output),
                      'scriptSha256': result['script']['sha256'], 'verifierSha256': result['verifier']['sha256'],
                      'pythonVersion': result['runtime']['pythonVersion']}))


if __name__ == '__main__':
    main()
