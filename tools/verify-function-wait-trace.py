"""Verify predicate trace ownership, terminal outcomes, source and referenced DOM captures."""

import hashlib
import json
from pathlib import Path
import sys
import zipfile

path = Path(sys.argv[1])
with zipfile.ZipFile(path) as archive:
    events = [json.loads(line) for name in archive.namelist() if name.endswith('.trace')
              for line in archive.read(name).decode().splitlines() if line]
    calls = [event for event in events if event['type'] == 'before' and event.get('method') == 'waitForFunction']
    if len(calls) != 3:
        raise ValueError(f'Expected three predicate calls, found {len(calls)}')
    completions = {event['callId']: event for event in events if event['type'] == 'after'}
    snapshots = {event['snapshot']['snapshotName'] for event in events if event['type'] == 'frame-snapshot'}
    failures = 0
    for call in calls:
        if call['class'] != 'Frame' or call['callId'] not in completions:
            raise ValueError('Predicate call lost its original Frame completion')
        completion = completions[call['callId']]
        failures += bool(completion.get('error'))
        for event, field in [(call, 'beforeSnapshot'), (completion, 'afterSnapshot')]:
            if event.get(field) not in snapshots:
                raise ValueError(f'Missing predicate {field} capture')
    if failures != 1:
        raise ValueError(f'Expected one retained timeout, found {failures}')
    sourceEntries = [name for name in archive.namelist() if name.startswith('resources/src@')]
    if not any(b'const selected = await page.waitForFunction' in archive.read(name) for name in sourceEntries):
        raise ValueError('Predicate caller source was not embedded')
    print(json.dumps({'status': 'passed', 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                      'predicateCalls': len(calls), 'failures': failures, 'snapshots': len(snapshots), 'sources': len(sourceEntries)}))
