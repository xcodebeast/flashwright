"""Verify action identity and captured input in the shared selector-action fixture."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile


def verify(directory):
    report = json.loads((directory / 'report.json').read_text())
    assert report['status'] == 'passed'
    assert report['outcomes']['reference'] == report['outcomes']['flashwright']
    archives = {}
    methods = ['click', 'dblclick', 'hover', 'check', 'uncheck', 'setChecked', 'fill', 'focus', 'selectOption', 'press', 'type']
    for engine in ['reference', 'flashwright']:
        path = directory / f'{engine}.zip'
        with zipfile.ZipFile(path) as archive:
            assert archive.testzip() is None
            events = [json.loads(line) for name in archive.namelist() if name.endswith('.trace') for line in archive.read(name).splitlines()]
            before = [event for event in events if event.get('type') == 'before']
            after = {event['callId']: event for event in events if event.get('type') == 'after'}
            assert len(before) == len(after)
            assert all(event['callId'] in after for event in before)
            snapshots = {event['snapshot']['snapshotName'] for event in events if event.get('type') == 'frame-snapshot'}
            assert snapshots
            inputs = {event['callId']: event for event in events if event.get('type') == 'input'}
            assert all(event['inputSnapshot'] in snapshots for event in inputs.values())
            assert any(event.get('type') == 'screencast-frame' for event in events)
            if engine == 'flashwright':
                for owner in ['page', 'frame']:
                    for method in methods:
                        calls = [event for event in before if event.get('title') == f'{owner}.{method}']
                        assert len(calls) >= 3, (owner, method)
                        strict = [event for event in calls if event['params'].get('options', {}).get('strict') is True]
                        assert any('strict mode violation' in after[event['callId']].get('error', {}).get('message', '') for event in strict)
                        successful = [event for event in calls if 'error' not in after[event['callId']]]
                        assert successful, (owner, method)
                        assert all(event['params'].get('selector') for event in calls)
                        assert all(event.get('stack') for event in calls)
                        assert all(event['beforeSnapshot'] in snapshots for event in calls)
                        if method in ['fill', 'selectOption', 'click', 'check', 'type', 'press']:
                            assert any(event['callId'] in inputs for event in successful), (owner, method)
                        if method == 'setChecked':
                            assert all(event['method'] == ('check' if event['params']['checked'] else 'uncheck') for event in calls)
                assert any(name.startswith('resources/src@') for name in archive.namelist())
            archives[engine] = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'calls': len(before), 'snapshots': len(snapshots), 'inputCalls': len(inputs)}
    result = {'status': 'passed', 'archives': archives, 'reportSha256': hashlib.sha256((directory / 'report.json').read_bytes()).hexdigest()}
    (directory / 'trace-verification.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    verify(Path(sys.argv[1]))
