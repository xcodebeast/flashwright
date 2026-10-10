"""Review frame-locator trace bindings without claiming identical capture layouts."""

import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import sys
import zipfile
from urllib.parse import unquote, urlsplit


NATIVE_INPUT_METHODS = {'click', 'fill', 'press', 'type', 'setInputFiles'}
FRAME_CONTROL = 'internal:control=enter-frame'


def require(condition, message):
    """Fail with a retained-evidence diagnostic, including under python -O."""
    if not condition:
        raise ValueError(message)


def sha256(content):
    return hashlib.sha256(content).hexdigest()


def semantic_outcomes(outcomes):
    """Compare public results while preserving original diagnostic differences."""
    return [
        {key: outcome.get(key) for key in (
            'name', 'traced', 'status',
            'value' if outcome['status'] == 'fulfilled' else 'category',
        )}
        for outcome in outcomes
    ]


class SnapshotStore:
    """Resolve the pinned format's per-frame, postorder subtree references.

    Reference node indices count explicit strings/elements only, excluding
    reference placeholders. Resolving references as ordinary tree children would
    shift indices and can falsely assign a target to an unrelated frame node.
    """

    def __init__(self, events):
        self.by_name = defaultdict(list)
        self.histories = defaultdict(list)
        self.backreferences = 0
        for event in events:
            if event['type'] != 'frame-snapshot':
                continue
            snapshot = event['snapshot']
            frame_key = (snapshot['pageId'], snapshot['frameId'])
            history = self.histories[frame_key]
            nodes = []
            history.append(nodes)
            snapshot_index = len(history) - 1

            def expand(node):
                if isinstance(node, str):
                    nodes.append(node)
                    return node
                require(isinstance(node, list) and node, 'Invalid snapshot node')
                if isinstance(node[0], list):
                    require(len(node) == 1 and len(node[0]) == 2,
                            'Invalid subtree reference')
                    distance, node_index = node[0]
                    require(type(distance) is int and type(node_index) is int,
                            'Noninteger subtree reference')
                    previous_index = snapshot_index - distance
                    require(distance >= 0 and 0 <= previous_index <= snapshot_index,
                            f'Invalid snapshot backreference in {frame_key}')
                    previous_nodes = history[previous_index]
                    require(0 <= node_index < len(previous_nodes),
                            f'Invalid node backreference in {frame_key}')
                    self.backreferences += 1
                    return previous_nodes[node_index]
                require(isinstance(node[0], str), 'Invalid snapshot element')
                attributes = node[1] if len(node) > 1 else {}
                require(isinstance(attributes, dict), 'Invalid snapshot attributes')
                expanded = [node[0], attributes, *[expand(child) for child in node[2:]]]
                nodes.append(expanded)
                return expanded

            expanded = expand(snapshot['html'])
            self.by_name[snapshot['snapshotName']].append((snapshot, expanded))

    def bound(self, name, call):
        """Return phase captures only after checking call and page ownership."""
        captures = self.by_name.get(name, [])
        for snapshot, _ in captures:
            require(snapshot.get('callId') == call['callId'],
                    f'{name}: snapshot belongs to another call')
            if call.get('pageId'):
                require(snapshot['pageId'] == call['pageId'],
                        f'{name}: snapshot belongs to another page')
        return captures


def elements(tree):
    """Walk expanded elements; attributes and text are not tree children."""
    if isinstance(tree, list):
        yield tree
        for child in tree[2:]:
            yield from elements(child)


def archive_stacks(archive):
    """Read reference sidecars; Flashwright embeds its stacks in before events."""
    stacks = {}
    for name in archive.namelist():
        if not name.endswith('.stacks'):
            continue
        content = json.loads(archive.read(name))
        for call_number, frames in content['stacks']:
            stacks[f'call@{call_number}'] = [
                {'file': content['files'][frame[0]], 'line': frame[1], 'column': frame[2]}
                for frame in frames
            ]
    return stacks


def source_evidence(archive, calls, report, engine):
    """Bind fixture call sites to archived source bytes, without reading live files."""
    sidecar_stacks = archive_stacks(archive)
    fixture_sources = {}
    observations = []
    for call in calls:
        stack = call.get('stack') or sidecar_stacks.get(call['callId'], [])
        fixture_frames = [frame for frame in stack
                          if frame['file'].replace('\\', '/').endswith('/compatibility/m2/frame-locators.mjs')]
        require(fixture_frames, f'{call["callId"]}: missing fixture call site')
        actual_frames = [frame for frame in fixture_frames if frame['file'].startswith('/')]
        require(actual_frames, f'{call["callId"]}: missing filesystem fixture call site')
        for frame in fixture_frames:
            source_path = frame['file']
            if engine == 'reference' and source_path.startswith('async file:///'):
                # The pinned parser leaves Node's anonymous async prefix in the file field.
                # Bind it only to an independently archived caller in this same stack.
                location = urlsplit(source_path.removeprefix('async '))
                require(not location.netloc and not location.query and not location.fragment,
                        'Invalid reference async source location')
                canonical_path = unquote(location.path)
                require(any(actual['file'] == canonical_path for actual in actual_frames),
                        'Reference async source has no matching filesystem caller')
                observations.append({'callId': call['callId'], 'observedFile': source_path,
                                     'archivedFile': canonical_path,
                                     'reason': 'pinned reference parser retains anonymous async prefix'})
                source_path = canonical_path
            source_name = 'resources/src@' + hashlib.sha1(source_path.encode()).hexdigest() + '.txt'
            require(source_name in archive.namelist(), f'Missing source artifact: {source_name}')
            source = archive.read(source_name)
            require(sha256(source) == report['fixtureSha256'],
                    f'{source_name}: fixture source differs from report')
            require(type(frame['line']) is int and 0 < frame['line'] <= len(source.splitlines()),
                    f'{call["callId"]}: invalid source line')
            require(type(frame['column']) is int and frame['column'] > 0,
                    f'{call["callId"]}: invalid source column')
            fixture_sources[source_name] = sha256(source)
    return fixture_sources, observations


def jpeg_dimensions(content):
    """Validate a retained JPEG header and read its encoded surface dimensions."""
    require(content.startswith(b'\xff\xd8') and content.endswith(b'\xff\xd9'),
            'Invalid filmstrip JPEG envelope')
    position = 2
    frame_markers = {0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf}
    while position < len(content):
        require(content[position] == 0xff, 'Invalid JPEG marker')
        while position < len(content) and content[position] == 0xff:
            position += 1
        require(position < len(content), 'Truncated JPEG marker')
        marker = content[position]
        position += 1
        if marker in {0x01, 0xd8} or 0xd0 <= marker <= 0xd7:
            continue
        require(position + 2 <= len(content), 'Truncated JPEG segment')
        length = int.from_bytes(content[position:position + 2], 'big')
        require(length >= 2 and position + length <= len(content), 'Invalid JPEG segment length')
        if marker in frame_markers:
            require(length >= 8, 'Invalid JPEG frame header')
            height = int.from_bytes(content[position + 3:position + 5], 'big')
            width = int.from_bytes(content[position + 5:position + 7], 'big')
            require(width > 0 and height > 0, 'Empty JPEG surface')
            return width, height
        require(marker != 0xda, 'JPEG has no frame header before scan')
        position += length
    raise ValueError('JPEG has no frame header')


def filmstrip_evidence(archive, events, input_pages):
    """Check every sampled resource and page binding, without equating sampling."""
    frames = [event for event in events if event['type'] == 'screencast-frame']
    require(frames, 'Missing filmstrip')
    pages = set()
    surfaces = set()
    resources = {}
    for frame in frames:
        name = f'resources/{frame["sha1"]}'
        require(name in archive.namelist(), f'Missing filmstrip resource: {name}')
        content = archive.read(name)
        dimensions = jpeg_dimensions(content)
        for field in ['timestamp', 'width', 'height']:
            require(isinstance(frame.get(field), (int, float)) and math.isfinite(frame[field]),
                    f'Invalid filmstrip {field}')
        require(frame['width'] > 0 and frame['height'] > 0, 'Invalid filmstrip reported surface')
        pages.add(frame['pageId'])
        surfaces.add((frame['width'], frame['height'], *dimensions))
        resources[name] = sha256(content)
    require(input_pages <= pages, 'A captured input page has no filmstrip frames')
    return {'frames': len(frames), 'pages': len(pages), 'resources': resources,
            'surfaces': [list(surface) for surface in sorted(surfaces)]}


def captured_targets(captures, call):
    """Prove marked targets reside in the requested iframe ancestry."""
    call_id = call['callId']
    selector = call['params']['selector']
    expected_owners = []
    for prefix in selector.split(FRAME_CONTROL)[:-1]:
        if '#nested' in prefix:
            expected_owners.append('nested')
        elif '#first' in prefix or '.child' in prefix:
            expected_owners.append('first')
        else:
            raise ValueError(f'{call_id}: uncharacterized native frame selector {selector}')
    expected_target = 'nested-button' if expected_owners[-1] == 'nested' else (
        'button' if call['method'] == 'click' else
        'upload' if call['method'] == 'setInputFiles' else 'text')
    parent_frames = {}
    main_frames = set()
    targets = []
    for snapshot, tree in captures:
        frame_id = snapshot['frameId']
        if snapshot.get('isMainFrame'):
            main_frames.add(frame_id)
        for element in elements(tree):
            attributes = element[1]
            if element[0].upper() == 'IFRAME' and attributes.get('src', '').startswith('/snapshot/'):
                child_frame = attributes['src'].removeprefix('/snapshot/')
                parent_frames[child_frame] = (frame_id, attributes.get('id'))
            if attributes.get('__playwright_target__') == call_id:
                require(not snapshot.get('isMainFrame'), f'{call_id}: target marked in main frame')
                targets.append((snapshot, attributes))
    require(targets, f'{call_id}: input snapshot has no captured child-frame target')
    matched_targets = []
    for snapshot, attributes in targets:
        owners = []
        current_frame = snapshot['frameId']
        visited = set()
        while current_frame not in main_frames:
            require(current_frame not in visited, f'{call_id}: cyclic snapshot frame ancestry')
            visited.add(current_frame)
            require(current_frame in parent_frames, f'{call_id}: target frame is not attached to snapshot root')
            current_frame, owner = parent_frames[current_frame]
            owners.append(owner)
        owners.reverse()
        require(owners[-len(expected_owners):] == expected_owners,
                f'{call_id}: wrong target frame ancestry {owners}, expected {expected_owners}')
        if attributes.get('id') == expected_target:
            matched_targets.append({'frameId': snapshot['frameId'], 'frameUrl': snapshot['frameUrl'],
                                    'targetId': expected_target, 'iframeOwners': owners})
    require(matched_targets, f'{call_id}: expected target {expected_target} is not marked')
    return matched_targets


def review_archive(directory, engine, report):
    """Validate paired actions, phases, sources, child targets and filmstrip."""
    path = directory / f'{engine}.zip'
    archive_hash = sha256(path.read_bytes())
    require(archive_hash == report['traces'][engine]['sha256'], f'{engine}: archive hash differs from report')
    with zipfile.ZipFile(path) as archive:
        require(archive.testzip() is None, f'{engine}: corrupt ZIP')
        require(len(archive.namelist()) == len(set(archive.namelist())), f'{engine}: duplicate ZIP entries')
        events = [json.loads(line) for name in archive.namelist() if name.endswith('.trace')
                  for line in archive.read(name).splitlines()]
        before_events = [event for event in events if event['type'] == 'before']
        after_events = [event for event in events if event['type'] == 'after']
        before = {event['callId']: event for event in before_events}
        after = {event['callId']: event for event in after_events}
        require(len(before) == len(before_events) and len(after) == len(after_events),
                f'{engine}: duplicate call phase')
        require(before and before.keys() == after.keys(), f'{engine}: unpaired calls')
        for call_id, call in before.items():
            require(call['startTime'] <= after[call_id]['endTime'], f'{call_id}: reversed call times')
        frame_calls = [call for call in before.values()
                       if FRAME_CONTROL in (call.get('params', {}).get('selector') or '')]
        require(frame_calls, f'{engine}: missing frame locator calls')
        snapshots = SnapshotStore(events)
        require(snapshots.by_name, f'{engine}: missing snapshots')
        differences = []
        failures = []
        phase_counts = defaultdict(int)
        for call in frame_calls:
            for phase, event in [('before', call), ('after', after[call['callId']])]:
                name = event.get(f'{phase}Snapshot')
                if engine == 'flashwright' and not (isinstance(name, str) and name):
                    failures.append(f'{call["callId"]}: missing {phase} snapshot name')
                if name:
                    captures = snapshots.bound(name, call)
                    if captures:
                        phase_counts[phase] += 1
                        continue
                error = after[call['callId']].get('error', {})
                expected_absence = 'closed' in error.get('message', '').lower()
                if not expected_absence and name is not None:
                    failures.append(f'{call["callId"]}: missing {phase} snapshot {name}')
                differences.append({'callId': call['callId'], 'method': call['method'],
                                    'title': call.get('title'), 'phase': phase,
                                    'snapshotName': name, 'expected': 'bound phase snapshot',
                                    'observed': 'absent', 'reason': 'target closed' if expected_absence else
                                    'unresolved advertised phase' if name else
                                    'reference method does not advertise this phase' if engine == 'reference' else
                                    'unresolved missing phase name'})
        input_events = [event for event in events if event['type'] == 'input']
        inputs = defaultdict(list)
        for event in input_events:
            require(event['callId'] in before, f'{engine}: orphan input event')
            captures = snapshots.bound(event['inputSnapshot'], before[event['callId']])
            require(captures, f'{event["callId"]}: input snapshot absent')
            inputs[event['callId']].append(event)
        native_calls = [call for call in frame_calls if call['method'] in NATIVE_INPUT_METHODS
                        and 'error' not in after[call['callId']]]
        require({call['method'] for call in native_calls} == NATIVE_INPUT_METHODS,
                f'{engine}: native input fixture coverage incomplete')
        input_pages = set()
        native_evidence = []
        for call in native_calls:
            if not inputs[call['callId']]:
                failures.append(f'{call["callId"]}: successful {call["method"]} has no input event')
                differences.append({'callId': call['callId'], 'method': call['method'], 'phase': 'input',
                                    'expected': 'bound input snapshot with captured child-frame target',
                                    'observed': 'absent', 'reason': 'unresolved native input phase'})
            for event in inputs[call['callId']]:
                captures = snapshots.bound(event['inputSnapshot'], call)
                targets = captured_targets(captures, call)
                input_pages.update(snapshot['pageId'] for snapshot, _ in captures)
                native_evidence.append({'callId': call['callId'], 'method': call['method'],
                                        'selector': call['params']['selector'],
                                        'inputSnapshot': event['inputSnapshot'], 'targets': targets})
        fixture_sources, source_observations = source_evidence(archive, frame_calls, report, engine)
        return {'sha256': archive_hash, 'calls': len(before), 'frameLocatorCalls': len(frame_calls),
                'snapshots': sum(len(captures) for captures in snapshots.by_name.values()),
                'snapshotNames': len(snapshots.by_name), 'validatedBackreferences': snapshots.backreferences,
                'boundFrameCallPhases': dict(phase_counts), 'inputEvents': len(input_events),
                'nativeInputCalls': len(native_calls), 'nativeInputs': native_evidence,
                'fixtureSources': fixture_sources, 'sourceFrameObservations': source_observations,
                'filmstrip': filmstrip_evidence(archive, events, input_pages),
                'phaseObservations': differences, 'failures': failures}


def verify(directory, output=None):
    """Write a review while leaving the original report and archives untouched."""
    report_path = directory / 'report.json'
    report = json.loads(report_path.read_text())
    require(report['status'] == 'passed' and not report['failures'], 'Fixture did not pass')
    require(semantic_outcomes(report['outcomes']['reference']) ==
            semantic_outcomes(report['outcomes']['flashwright']), 'Semantic fixture outcomes differ')
    result = {
        'schemaVersion': 1, 'status': 'passed', 'reportSha256': sha256(report_path.read_bytes()),
        'scope': 'Paired call identities, captured phase ownership, resolvable snapshot backreferences, '
                 'successful native pointer/keyboard/upload child-frame targets, fixture call sites/source bytes '
                 'and filmstrip resource/page bindings for the frame-locator fixture.',
        'limitations': [
            'Input snapshots can describe attempted input on failed calls; their presence does not prove '
            'that browser input occurred. Trusted-input outcomes are checked by the shared fixture.',
            'Trace call/snapshot/input/filmstrip counts and layouts need not match. JPEG headers and '
            'resource bindings do not establish rendered visual fidelity or public viewer parity.',
        ],
        'archives': {engine: review_archive(directory, engine, report)
                     for engine in ['reference', 'flashwright']},
    }
    result['status'] = 'failed' if any(archive['failures'] for archive in result['archives'].values()) else 'passed'
    output = output or directory / 'trace-verification.json'
    output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'output': str(output),
                      'archives': {engine: {key: evidence[key] for key in
                                           ['calls', 'snapshots', 'inputEvents', 'nativeInputCalls']}
                                   for engine, evidence in result['archives'].items()}}))
    return result['status'] == 'passed'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--output', type=Path)
    arguments = parser.parse_args()
    try:
        if not verify(arguments.directory, arguments.output):
            sys.exit(1)
    except (ValueError, KeyError, OSError, zipfile.BadZipFile) as error:
        print(f'Frame-locator trace verification failed: {error}', file=sys.stderr)
        sys.exit(1)
