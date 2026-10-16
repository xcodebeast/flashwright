"""Verify one canonical request wait and its original successful completion."""
import json
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    assert archive.testzip() is None, 'Corrupt trace archive'
    events = [json.loads(line) for name in archive.namelist() if name.endswith('.trace')
              for line in archive.read(name).splitlines()]
calls = [event for event in events if event.get('type') == 'before' and event.get('method') == 'waitForRequest']
assert len(calls) == 1, 'Expected one canonical request wait'
call = calls[0]
assert call['class'] == 'Page' and call.get('pageId'), 'Request wait lost its page owner'
assert call['params']['urlOrPredicate'] == '/traced', 'Request wait lost its original matcher'
after = [event for event in events if event.get('type') == 'after' and event.get('callId') == call['callId']]
assert len(after) == 1 and 'error' not in after[0], 'Request wait must complete once'
assert after[0]['endTime'] >= call['startTime']
triggers = [event for event in events if event.get('type') == 'before' and event.get('method') == 'evaluateExpression']
assert len(triggers) == 1 and triggers[0].get('pageId') == call['pageId'], 'Trigger must retain the request wait page owner'
assert not any(event.get('type') == 'before' and event.get('method') == 'waitForEvent' for event in events), 'Internal delegation must not create a duplicate public trace call'
print(json.dumps({'status': 'passed', 'method': 'Page.waitForRequest', 'calls': 1,
                  'scope': 'Canonical request-wait API record, original page and successful completion; snapshots/screenshots intentionally disabled.'}))
