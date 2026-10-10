"""Require both retained input attempts and preserve the pinned first-snapshot order."""
import importlib.util
import json
from pathlib import Path
import sys
import zipfile

module_path = Path(__file__).with_name('verify-frame-locator-traces.py')
specification = importlib.util.spec_from_file_location('frame_locator_traces', module_path)
reader = importlib.util.module_from_spec(specification)
specification.loader.exec_module(reader)

with zipfile.ZipFile(sys.argv[1]) as archive:
    reader.require(archive.testzip() is None, 'Corrupt trace archive')
    events = [json.loads(line) for name in archive.namelist() if name.endswith('.trace')
              for line in archive.read(name).splitlines()]
calls = [event for event in events if event.get('type') == 'before'
         and event.get('method') == 'setInputFiles']
reader.require(len(calls) == 1, 'Expected exactly one public upload')
call = calls[0]
completions = [event for event in events if event.get('type') == 'after'
               and event['callId'] == call['callId']]
reader.require(len(completions) == 1 and 'error' not in completions[0], 'Upload did not succeed')
snapshots = reader.SnapshotStore(events)
attempts = []
for snapshot, tree in snapshots.bound('input@' + call['callId'], call):
    for element in reader.elements(tree):
        if element[1].get('__playwright_target__') == call['callId']:
            reader.require(element[1].get('id') == 'upload', 'Wrong captured upload target')
            attempts.append(element[1].get('data-version'))
reader.require(attempts == ['original', 'replacement'],
               f'Expected both input attempts in original order, received {attempts}')
print(json.dumps({'status': 'passed', 'capturedInputAttempts': attempts,
                  'viewerFirstSnapshotTarget': attempts[0],
                  'scope': 'Archive attempt history; pinned viewer selects the first same-name snapshot.'}))
