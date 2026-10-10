"""Check Download metadata custody separately from shared browser outcomes."""

import hashlib
import json
from pathlib import Path
import sys
import zipfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify(directory):
    report = json.loads((directory / 'report.json').read_text())
    require(report['status'] == 'passed', 'Download comparison did not pass')
    require(len(report['runs']) == 4, 'Missing engine/mode run')
    artifacts = []
    methods = set()
    successes = failures = reference_download_calls = 0
    for run in report['runs']:
        report_path = directory / run['report']
        content = report_path.read_bytes()
        require(hashlib.sha256(content).hexdigest() == run['sha256'], 'Changed run report')
        result = json.loads(content)
        require(result['status'] == 'passed', 'Failed Download run')
        require(not any(result[key] for key in [
            'implementationChangedDuringVerification', 'sourceChangedDuringVerification',
            'browserChangedDuringVerification']), 'Changed verification identities')
        require(len(result['traces']) == (13 if result['traced'] else 0), 'Missing trace archive')
        for recorded_path in result['traces']:
            path = report_path.parent / Path(recorded_path).name
            with zipfile.ZipFile(path) as archive:
                events = [json.loads(line) for name in archive.namelist() if name.endswith('.trace')
                          for line in archive.read(name).splitlines()]
            before = [event for event in events if event['type'] == 'before']
            after = {event['callId']: event for event in events if event['type'] == 'after'}
            require(len(after) == len(before), f'{path.name}: unmatched call boundaries')
            require(len({event['callId'] for event in before}) == len(before), 'Duplicate call identity')
            download_calls = [event for event in before if event.get('class') == 'Download']
            if result['engine'] == 'playwright':
                reference_download_calls += len(download_calls)
            else:
                require(download_calls, f'{path.name}: missing Download metadata')
                pages = {event['pageId'] for event in before
                         if event.get('class') == 'Frame' and event['method'] == 'goto'}
                require(len(pages) == 1, 'Expected one original page per trace')
                waits = [event for event in before if event.get('class') == 'Page'
                         and event['method'] == 'waitForEvent'
                         and event.get('params', {}).get('event') == 'download']
                require(waits, 'Missing download event wait metadata')
                for call in download_calls + waits:
                    terminal = after[call['callId']]
                    require(call.get('pageId') in pages, 'Metadata changed original page')
                    require(terminal['endTime'] >= call['startTime'], 'Invalid call clock')
                    require(not any(field in call or field in terminal for field in
                                    ['beforeSnapshot', 'inputSnapshot', 'afterSnapshot']),
                            'Download metadata requested document capture')
                    require(not any(event['type'] == 'frame-snapshot'
                                    and event['snapshot'].get('callId') == call['callId']
                                    for event in events), 'Download call acquired a DOM snapshot')
                    require(any(frame['file'].endswith('/compatibility/m2/downloads.mjs')
                                and frame['line'] > 0 for frame in call.get('stack', [])),
                            'Download metadata lost fixture caller')
                    if call.get('class') == 'Download':
                        methods.add(call['method'])
                        require(call['title'] == 'download.' + call['method'], 'Wrong Download title')
                        if 'error' in terminal:
                            failures += 1
                        else:
                            successes += 1
            artifacts.append({'path': str(path.relative_to(directory)),
                              'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                              'calls': len(before), 'downloadCalls': len(download_calls)})
    require(methods == {'path', 'saveAs', 'failure', 'cancel', 'delete', 'createReadStream'},
            'Missing async Download method metadata')
    require(successes > 0 and failures > 0, 'Missing success or failure diagnostics')
    return {'status': 'passed', 'archives': artifacts, 'downloadMethods': sorted(methods),
            'successfulDownloadCalls': successes, 'failedDownloadCalls': failures,
            'referenceDownloadCalls': reference_download_calls,
            'scope': 'Original-page metadata, complete call boundaries, caller locations and absent DOM captures. Reference may omit Download calls; no identical trace-layout or visual-fidelity claim. Context-close-active is untraced; other archives finalize before context closure.'}


if __name__ == '__main__':
    directory = Path(sys.argv[1])
    result = verify(directory)
    (directory / 'trace-verification.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'archives': len(result['archives'])}))
