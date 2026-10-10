"""Check public snapshot trace actions and their referenced native frame captures."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

path = Path(sys.argv[1])
engine = sys.argv[2]
with zipfile.ZipFile(path) as archive:
    events = [json.loads(line) for name in archive.namelist() if name.endswith('.trace')
              for line in archive.read(name).decode().splitlines() if line]
    sourceEntries = [name for name in archive.namelist() if name.startswith('resources/src@')]
    if not any(b'const pageSnapshot = await page.ariaSnapshot();' in archive.read(name) for name in sourceEntries):
        raise ValueError('ARIA caller source was not embedded')
    snapshots = {event['snapshot']['snapshotName'] for event in events if event['type'] == 'frame-snapshot'}
    calls = [event for event in events if event['type'] == 'before' and event.get('method') == 'ariaSnapshot']
    if len(calls) != 2:
        raise ValueError(f'Expected exactly two admitted snapshot actions, found {len(calls)}')
    after = {event['callId']: event for event in events if event['type'] == 'after'}
    for call in calls:
        if call['class'] != 'Frame' or call['callId'] not in after or after[call['callId']].get('error'):
            raise ValueError('Snapshot action lost Frame ownership or successful completion')
        for record, field in [(call, 'beforeSnapshot'), (after[call['callId']], 'afterSnapshot')]:
            if record.get(field):
                raise ValueError(f'ARIA getter unexpectedly declares a {field} DOM capture')
    if snapshots:
        raise ValueError('ARIA getter trace unexpectedly captured DOM snapshots')
    screenshots = sum(event['type'] == 'screencast-frame' for event in events)
    if not screenshots:
        raise ValueError('ARIA getter trace lost its enabled filmstrip')
    print(json.dumps({'status': 'passed', 'engine': engine, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                      'snapshotActions': len(calls), 'frameSnapshots': len(snapshots), 'filmstripFrames': screenshots, 'embeddedSources': len(sourceEntries),
                      'scope': 'Frame ownership, successful actions, and filmstrip without DOM snapshot references; no pixel-fidelity claim'}))
