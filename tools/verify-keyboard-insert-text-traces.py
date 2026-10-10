"""Require native text insertion snapshots to retain their original call and page."""

import importlib.util
import json
from pathlib import Path
import sys
import zipfile

module_path = Path(__file__).with_name('verify-frame-locator-traces.py')
specification = importlib.util.spec_from_file_location('frame_locator_traces', module_path)
reader = importlib.util.module_from_spec(specification)
specification.loader.exec_module(reader)


def verify(path, phases):
    with zipfile.ZipFile(path) as archive:
        reader.require(archive.testzip() is None, 'Corrupt insertion trace')
        events = [json.loads(line) for name in archive.namelist() if name.endswith('.trace')
                  for line in archive.read(name).splitlines()]
    calls = [event for event in events if event.get('type') == 'before'
             and event.get('method') == 'keyboardInsertText']
    reader.require(len(calls) == 1, 'Expected one admitted insertion trace call')
    call = calls[0]
    reader.require(call.get('class') == 'Page', 'Wrong native trace class')
    reader.require(call.get('params', {}).get('text') == 'traceé😃', 'Insertion trace lost its original text')
    completions = [event for event in events if event.get('type') == 'after'
                   and event.get('callId') == call['callId']]
    reader.require(len(completions) == 1 and 'error' not in completions[0], 'Insertion did not complete once')
    inputs = [event for event in events if event.get('type') == 'input'
              and event.get('callId') == call['callId']]
    reader.require(len(inputs) == 1, 'Insertion must retain one input snapshot phase')
    reader.require('beforeSnapshot' not in call, 'Direct insertion must not advertise a before snapshot')
    snapshots = reader.SnapshotStore(events)
    reader.require(not snapshots.by_name.get(f'before@{call["callId"]}'), 'Direct insertion must not capture an extra before phase')
    values = {'before': 'original', 'input': 'original', 'after': 'otraceé😃nal'}
    for phase in phases:
        expected_value = values[phase]
        captures = snapshots.bound(f'{phase}@{call["callId"]}', call)
        reader.require(captures, f'Missing original {phase} phase')
        targets = [element for _, tree in captures for element in reader.elements(tree)
                   if element[1].get('id') == 'target']
        reader.require(len(targets) == 1, f'{phase}: wrong target ownership')
        reader.require(targets[0][1].get('__playwright_value_') == expected_value,
                       f'{phase}: wrong original input value')
    return {'path': str(path), 'status': 'passed', 'phases': phases}


reader.require(len(sys.argv) == 3, 'Supply reference and Flashwright insertion trace archives')
print(json.dumps({'status': 'passed', 'archives': [verify(sys.argv[1], ['input', 'after']),
                                                 verify(sys.argv[2], ['input', 'after'])],
                  'scope': 'Original call/page snapshot ownership and insertion values; no performance claim.'}))
