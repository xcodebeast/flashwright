"""Capture diagnostic Linux cgroup evidence in a caller-owned delegated leaf.

The caller must provide an independent outer deadline and remove its service
and cgroup afterward. This coordinator never admits benchmark resources.
"""

import argparse
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import sys
import time
import uuid

try:
    from . import final_goal_capture_context as inputs
    from . import linux_cgroup_policy as policy
except ImportError:
    import final_goal_capture_context as inputs
    import linux_cgroup_policy as policy


WRAPPER = Path('/usr/bin/bwrap')
WRAPPER_FLAGS = ['--unshare-user', '--unshare-cgroup', '--bind', '/', '/',
                 '--dev-bind', '/dev', '/dev', '--proc', '/proc',
                 '--ro-bind', '/sys/fs/cgroup', '/sys/fs/cgroup', '--cap-drop', 'ALL', '--']
MAXIMUM_NATIVE_BYTES = 4 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def save(path, value):
    return inputs.write_receipt(path, value)


def load(path, maximum=inputs.MAXIMUM_SNAPSHOT_BYTES):
    receipt, raw = inputs.read_stable_file(str(path), maximum, True)
    return receipt, inputs.decode(raw)


def error_record(error):
    return {'type': type(error).__name__, 'message': str(error)}


def wait_collector(process, timeout_seconds):
    """Retain the consuming terminal wait; Popen can invent zero on ECHILD."""
    deadline = time.monotonic() + timeout_seconds
    signals = []
    while True:
        started = time.monotonic_ns()
        try:
            pid, status, usage = os.wait4(process.pid, os.WNOHANG)
        except ChildProcessError as error:
            raise ValueError('Original collector terminal wait is unavailable') from error
        finished = time.monotonic_ns()
        if pid == process.pid:
            require(os.WIFEXITED(status) or os.WIFSIGNALED(status), 'Collector wait was not terminal')
            process.returncode = os.waitstatus_to_exitcode(status)
            return {'process': pid, 'status': status, 'exitCode': process.returncode,
                    'method': 'atomic-wait4-collector', 'startedNanoseconds': str(started),
                    'finishedNanoseconds': str(finished), 'userSeconds': usage.ru_utime,
                    'systemSeconds': usage.ru_stime, 'inclusiveMaximumRssKiB': usage.ru_maxrss}, signals
        if time.monotonic() >= deadline:
            require(len(signals) < 2, 'Collector did not terminate after forced cleanup; caller must stop its service')
            number = signal.SIGTERM if not signals else signal.SIGKILL
            # Do not use Popen.send_signal: its poll may reap the child before
            # this function can obtain the original terminal usage receipt.
            try:
                os.kill(process.pid, number)
            except ProcessLookupError:
                pass  # The next original wait must still resolve or reject.
            signals.append({'signal': int(number), 'sentNanoseconds': str(time.monotonic_ns())})
            deadline = time.monotonic() + 5
        time.sleep(.005)


def policy_projection(snapshot):
    """Compare observations, not acquisition times or mutable directory mtimes."""
    require(snapshot['status'] == 'diagnostic-snapshot' and not snapshot['resourceAdmission'],
            'Expected diagnostic policy observations')
    return {
        'leaf': snapshot['leaf'], 'mount': snapshot['mount'],
        'mountinfoSha256': snapshot['mountinfoSha256'], 'namespaceIds': snapshot['namespaceIds'],
        'nodes': [{'path': row['path'], 'hierarchyPath': row['hierarchyPath'], 'mountId': row['mountId'],
                   'identity': {key: row['directoryIdentity'][key] for key in ('device', 'inode', 'mode')},
                   'files': {name: {key: item.get(key) for key in
                                   ('status', 'raw', 'errno', 'error', 'mountId', 'identity',
                                    'controllerInObservedParentSubtree')}
                             for name, item in row['files'].items()}}
                  for row in snapshot['ancestorsLeafFirst']]
    }


def boundary(context, leaf, collector, destination, before=None):
    record = {'schemaVersion': 1, 'status': 'failed', 'captureIdentity': context.capture_identity,
              'phase': 'after' if before else 'before', 'startedNanoseconds': str(time.monotonic_ns()),
              'workloadCommand': context.command, 'supervisorProcess': os.getpid()}
    try:
        record['host'] = inputs.read_linux_host()
        record['inputs'] = context.collect_inputs()
        tool_paths = {'coordinator': Path(__file__).resolve(), 'inputReader': Path(inputs.__file__).resolve(),
                      'policyReader': Path(policy.__file__).resolve(), 'interpreter': Path(sys.executable).resolve(),
                      'collector': collector, 'wrapper': WRAPPER}
        record['tools'] = {name: inputs.read_stable_file(str(path))[0] for name, path in tool_paths.items()}
        require(all(record['tools'][name]['mode'] & 0o111 for name in ('interpreter', 'collector', 'wrapper')),
                'Capture executable is not executable')
        record['interpreterVersion'] = sys.version
        record['workingDirectory'] = str(Path.cwd())
        record['policy'] = policy.read_policy(leaf)
        require(inputs.read_linux_host() == record['host'], 'Host changed during boundary capture')
        if before:
            for key in ('host', 'inputs', 'tools', 'interpreterVersion', 'workingDirectory',
                        'workloadCommand', 'supervisorProcess', 'captureIdentity'):
                require(record[key] == before[key], 'Capture changed after execution: ' + key)
            require(policy_projection(record['policy']) == policy_projection(before['policy']),
                    'Visible resource policy changed after execution')
        record['status'] = 'verified'
    except Exception as error:
        record['error'] = error_record(error)
    record['finishedNanoseconds'] = str(time.monotonic_ns())
    return save(destination, record), record


def native_summary(native, identity, command, leaf_identity, before, after, collector_process):
    """Join original native bytes; preserve rejected cleanup instead of admitting it."""
    require(type(native.get('schemaVersion')) is int and native['schemaVersion'] == 1
            and native.get('captureClass') == 'experimental-linux-cgroup-command'
            and native.get('resourceAdmission') is False, 'Wrong native capture class')
    require(native['identity'] == identity and native['clock'] == 'clock_gettime(CLOCK_MONOTONIC)',
            'Native identity or clock differs')
    require(native['collectorProcess'] == collector_process, 'Native collector process differs')
    require(native['commandEncoding'] == 'Each original argv byte is represented by its equal-valued Unicode codepoint'
            and native['commandBytes'] == [os.fsencode(arg).decode('latin1') for arg in command],
            'Native wrapper command differs')
    require(native['cgroupDevice'] == leaf_identity['device'] and native['cgroupInode'] == leaf_identity['inode'],
            'Native leaf identity differs')
    for name in ('afterValid', 'identityUnchanged', 'finalLeaf', 'timedOut', 'groupKilled',
                 'noRemainingChildren', 'cleanupError', 'cleanObservedTeardown'):
        require(type(native[name]) is bool, 'Invalid native boolean: ' + name)
    for name in ('collectorProcess', 'ownerProcess', 'launchErrno', 'interruptedSignal', 'survivorsAfterOwner', 'adoptedChildren'):
        require(type(native[name]) is int, 'Invalid native integer: ' + name)
    require(native['afterValid'] and native['identityUnchanged'], 'Native final counters or identity were invalid')

    def timestamp(value):
        require(isinstance(value, str) and re.fullmatch(r'[1-9][0-9]{0,19}', value), 'Invalid native timestamp')
        return int(value)

    start = timestamp(native['cloneStartedNanoseconds'])
    finish = timestamp(native['cloneFinishedNanoseconds'])
    require(int(before['finishedNanoseconds']) <= start <= finish <= int(after['startedNanoseconds']),
            'Boundary snapshots do not bracket native launch')
    for snapshot in (native['before'], native['after']):
        a, b = timestamp(snapshot['startedNanoseconds']), timestamp(snapshot['finishedNanoseconds'])
        require(int(before['finishedNanoseconds']) <= a <= b <= int(after['startedNanoseconds']),
                'Native counters are outside capture boundaries')
    require(int(native['before']['finishedNanoseconds']) <= start
            and finish <= int(native['after']['startedNanoseconds']), 'Native counter ordering differs')
    wait = native['originalWait']
    require(wait is not None and native['launchErrno'] == 0 and native['ownerProcess'] > 0,
            'Missing successful native launch or original terminal wait')

    def terminal_wait(wait):
        require(type(wait['process']) is int and wait['process'] > 0 and type(wait['status']) is int
                and wait['status'] >= 0, 'Invalid native terminal identity/status')
        require(os.WIFEXITED(wait['status']) or os.WIFSIGNALED(wait['status']), 'Native wait is not terminal')
        for name in ('userMicroseconds', 'systemMicroseconds'):
            require(type(wait[name]) is int and wait[name] >= 0, 'Invalid native wait CPU field')
        require(finish <= timestamp(wait['startedNanoseconds']) <= timestamp(wait['finishedNanoseconds'])
                <= int(native['after']['startedNanoseconds']), 'Native wait is outside counter boundaries')

    if wait is not None:
        terminal_wait(wait)
        require(wait['method'] == 'atomic-wait4-original-owner' and wait['process'] == native['ownerProcess'],
                'Native original wait belongs to another process')
        require(type(wait['exitCode']) is int and wait['exitCode'] == os.waitstatus_to_exitcode(wait['status']),
                'Native exit code differs from terminal status')
    require(type(native['adoptedChildren']) is int and 0 <= native['adoptedChildren']
            and len(native['adoptedWaits']) == min(native['adoptedChildren'], 8192), 'Invalid native adopted-wait inventory')
    for adopted in native['adoptedWaits']:
        terminal_wait(adopted)

    def counters(text):
        require(isinstance(text, str) and len(text) < 4096 and text.endswith('\n'), 'Invalid native counters')
        values = {}
        for line in text.splitlines():
            parts = line.split(' ')
            require(len(parts) == 2 and re.fullmatch(r'[a-z0-9_.]{1,63}', parts[0])
                    and re.fullmatch(r'[0-9]{1,20}', parts[1]) and int(parts[1]) < 2**64
                    and parts[0] not in values, 'Malformed or duplicate native counter')
            values[parts[0]] = int(parts[1])
        return values

    parsed = []
    for snapshot in (native['before'], native['after']):
        cpu, events = counters(snapshot['cpuStat']), counters(snapshot['events'])
        require(snapshot['type'] == 'domain\n' and re.fullmatch(r'[0-9]{1,20}\n', snapshot['memoryPeak'])
                and int(snapshot['memoryPeak']) < 2**64, 'Invalid native domain or memory peak')
        require(events['populated'] in (0, 1) and all(name in cpu for name in ('usage_usec', 'user_usec', 'system_usec')),
                'Missing native counters')
        parsed.append((cpu, events['populated'], int(snapshot['memoryPeak'])))
    initial_cpu, initial_population, initial_peak = parsed[0]
    final_cpu, final_population, final_peak = parsed[1]
    require(not initial_population and not initial_peak and native['before']['processes'] == ''
            and all(initial_cpu[name] == 0 for name in ('usage_usec', 'user_usec', 'system_usec')),
            'Native cgroup was not initially unused')
    clean = (not native['timedOut'] and not native['interruptedSignal'] and not native['groupKilled']
             and not native['cleanupError'] and not native['adoptedChildren'] and native['finalLeaf']
             and native['survivorsAfterOwner'] == 0 and native['noRemainingChildren']
             and final_population == 0 and native['after']['processes'] == ''
             and all(final_cpu[name] >= initial_cpu[name] for name in ('usage_usec', 'user_usec', 'system_usec'))
             and final_peak >= initial_peak)
    require(native['cleanObservedTeardown'] == clean, 'Native clean-teardown predicate differs')
    return {'status': 'joined-diagnostic-native-receipt', 'originalWrapperWait': wait,
            'cleanObservedTeardown': native['cleanObservedTeardown'],
            'adoptedChildren': native['adoptedChildren'], 'timedOut': native['timedOut'],
            'groupKilled': native['groupKilled'], 'noRemainingChildren': native['noRemainingChildren'],
            'identityUnchanged': native['identityUnchanged'], 'afterValid': native['afterValid'],
            'resourceAdmission': False}


def capture(leaf, collector, request, directory, timeout_ms, command):
    require(sys.platform == 'linux' and platform.machine() == 'x86_64', 'Capture requires Linux x64')
    require(type(timeout_ms) is int and 50 <= timeout_ms <= 3600000, 'Timeout must be 50..3600000 milliseconds')
    require(1 <= len(command) <= 4096 and os.path.isabs(command[0])
            and sum(len(os.fsencode(arg)) + 1 for arg in command) <= 1024 * 1024
            and all('\0' not in arg for arg in command), 'Invalid bounded absolute runtime command')
    leaf = policy._absolute(os.fspath(leaf))
    collector = Path(collector).resolve(strict=True)
    directory = Path(directory).absolute()
    workbench = Path(__file__).resolve().parents[1] / 'workbench'
    require(directory.resolve().is_relative_to(workbench.resolve()) and directory.resolve() != workbench.resolve(),
            'Raw diagnostic output must be in workbench')
    directory.mkdir(parents=True, exist_ok=False)
    identity = uuid.uuid4().hex
    wrapper_command = [str(WRAPPER), *WRAPPER_FLAGS, *command]
    native_path = directory / 'native.json'
    invocation = [str(collector), leaf, str(native_path), identity, str(timeout_ms), *wrapper_command]
    context = inputs.CaptureContext(request, identity, command)
    report = {'schemaVersion': 1, 'status': 'rejected', 'captureClass': 'diagnostic-linux-cgroup-capture',
              'captureIdentity': identity, 'resourceAdmission': False, 'performanceAccepted': False,
              'workloadCommand': command, 'wrapperCommand': wrapper_command, 'collectorCommand': invocation,
              'timeoutMilliseconds': timeout_ms, 'originalCollectorWait': None,
              'outerCleanupRequired': False, 'callerOwnsServiceAndGroupRemoval': True,
              'limitations': [
                  'The native original wait belongs to the wrapper, not the inner runtime; no CPU totals are added.',
                  'Policy snapshots are sequential and may miss transient changes or hidden enforcing ancestors.',
                  'Input hashes warm file caches outside the command interval; this is not a cold-start sample.',
                  'Declared input completeness, live executable identity, environment and workload/backend coverage require separate admission.',
                  'The wrapper restricts tested paths; foreign ingress, host migration and externally supplied writable aliases/helpers are not attested.',
                  'Kernel charged memory is not sampled concurrent RSS; no final resource metric is derived.'
              ]}
    before = after = None
    after_attempted = False
    try:
        report['before'], before = boundary(context, leaf, collector, directory / 'before.json')
        require(before['status'] == 'verified', 'Before snapshot rejected; command was not launched')
        leaf_identity = before['policy']['ancestorsLeafFirst'][0]['directoryIdentity']
        with (directory / 'stdout.txt').open('xb') as stdout, (directory / 'stderr.txt').open('xb') as stderr:
            process = subprocess.Popen(invocation, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                       close_fds=True)
            report['collectorProcess'] = process.pid
            report['originalCollectorWait'], report['collectorSignals'] = wait_collector(process, timeout_ms / 1000 + 8)
            report['outerCleanupRequired'] = bool(report['collectorSignals'])
        after_attempted = True
        report['after'], after = boundary(context, leaf, collector, directory / 'after.json', before)
        retained_before, _ = load(directory / 'before.json')
        require(retained_before['sha256'] == report['before']['sha256']
                and retained_before['bytes'] == report['before']['bytes'], 'Original before snapshot was changed')
        report['nativeReceipt'], native = load(native_path, MAXIMUM_NATIVE_BYTES)
        report['native'] = native_summary(native, identity, wrapper_command, leaf_identity, before, after, process.pid)
        require(int(native['after']['finishedNanoseconds'])
                <= int(report['originalCollectorWait']['finishedNanoseconds']) <= int(after['startedNanoseconds']),
                'Collector wait does not bracket completed native capture')
        require(report['originalCollectorWait']['exitCode'] == (0 if native['cleanObservedTeardown'] else 1),
                'Collector exit differs from its completed native receipt; publication may have failed')
        report['outerCleanupRequired'] = (report['outerCleanupRequired'] or not native['noRemainingChildren']
                                          or native['cleanupError'] or native['after']['processes'] != '')
        require(after['status'] == 'verified', 'After snapshot rejected')
        require(not report['outerCleanupRequired'], 'Collector exceeded its completion deadline')
        # A nonzero collector/workload or rejected teardown remains a captured
        # diagnostic outcome; neither status nor this exit admits resources.
        report['status'] = 'captured'
    except Exception as error:
        report['error'] = error_record(error)
        if before and before['status'] == 'verified' and after is None and not after_attempted:
            try:
                report['after'], after = boundary(context, leaf, collector, directory / 'after.json', before)
            except Exception as after_error:
                report['afterCaptureError'] = error_record(after_error)
        report['outerCleanupRequired'] = (report['outerCleanupRequired']
                                          or ('collectorProcess' in report and report['originalCollectorWait'] is None))
    finally:
        save(directory / 'capture.json', report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--leaf', required=True)
    parser.add_argument('--collector', required=True)
    parser.add_argument('--inputs', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--timeout-ms', type=int, required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    report = capture(args.leaf, args.collector, args.inputs, args.output, args.timeout_ms, command)
    print(inputs.encode({'status': report['status'], 'resourceAdmission': False,
                        'report': str(Path(args.output).absolute() / 'capture.json')}).decode())
    return 0 if report['status'] == 'captured' else 1


if __name__ == '__main__':
    sys.exit(main())
