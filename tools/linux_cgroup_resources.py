"""Reconstruct Linux cgroup observations from original capture files.

CPU charges, charged memory and terminal-wait usage are distinct metrics. This
reader verifies local evidence consistency; it never admits a final comparison.
"""

import argparse
import math
import os
from pathlib import Path
import stat
import sys

try:
    from . import final_goal_capture_context as inputs
    from .linux_cgroup_capture import MAXIMUM_NATIVE_BYTES, WRAPPER, WRAPPER_FLAGS, native_summary, policy_projection
except ImportError:
    import final_goal_capture_context as inputs
    from linux_cgroup_capture import MAXIMUM_NATIVE_BYTES, WRAPPER, WRAPPER_FLAGS, native_summary, policy_projection


ACCOUNTING_CLASS = 'linux-cgroup-v2-charged-scope-v1'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_record(path, maximum):
    receipt, raw = inputs.read_stable_file(str(path), maximum, True)
    return receipt, inputs.decode(raw)


def member(directory, receipt, name, maximum):
    require(isinstance(receipt, dict), 'Missing original ' + name + ' receipt')
    expected = directory / name
    inputs.verify_receipt({key: receipt[key] for key in ('path', 'bytes', 'sha256')})
    require(receipt['path'] == str(expected) and 0 < receipt['bytes'] <= maximum,
            'Unexpected original member path or byte count: ' + name)
    require(stat.S_ISREG(expected.lstat().st_mode), 'Original member must be a regular non-symlink file')
    actual, record = read_record(expected, receipt['bytes'])
    require(actual['resolvedPath'] == str(expected) and actual['sha256'] == receipt['sha256']
            and actual['bytes'] == receipt['bytes'], 'Original member bytes differ: ' + name)
    return actual, record


def verify_boundaries(report, before, after):
    for phase, snapshot in (('before', before), ('after', after)):
        require(type(snapshot.get('schemaVersion')) is int and snapshot['schemaVersion'] == 1 and snapshot.get('status') == 'verified'
                and snapshot.get('phase') == phase, 'Unverified original boundary')
        require(snapshot['captureIdentity'] == report['captureIdentity']
                and snapshot['workloadCommand'] == report['workloadCommand'], 'Boundary identity or command differs')
        require(snapshot['host']['configuration']['platform'] == 'linux'
                and snapshot['host']['configuration']['architecture'] == 'x64', 'Wrong capture platform')
        identity = inputs.digest(inputs.encode({'configuration': snapshot['host']['configuration'],
                                               'bootIdentitySha256': snapshot['host']['bootIdentitySha256']}))
        require(snapshot['host']['identitySha256'] == identity
                and snapshot['host']['namespace'] == identity + ':' + snapshot['host']['bootIdentitySha256'],
                'Invalid original host/boot binding')
        require(snapshot['inputs']['executables']['runtime']['resolvedPath']
                == next(row['resolvedPath'] for row in snapshot['inputs']['files']
                        if row['path'] == snapshot['workloadCommand'][0]), 'Missing declared runtime binding')
        require(int(snapshot['startedNanoseconds']) <= int(snapshot['finishedNanoseconds']), 'Reversed boundary interval')
    for key in ('host', 'inputs', 'tools', 'interpreterVersion', 'workingDirectory', 'supervisorProcess'):
        require(before[key] == after[key], 'Original boundaries differ: ' + key)
    require(policy_projection(before['policy']) == policy_projection(after['policy']), 'Original policy boundaries differ')
    require(before['tools']['wrapper']['path'] == str(WRAPPER), 'Unexpected wrapper executable')
    require(set(before['tools']) == {'coordinator', 'inputReader', 'policyReader', 'interpreter', 'collector', 'wrapper'},
            'Missing capture tool identity')
    require(report['wrapperCommand'] == [str(WRAPPER), *WRAPPER_FLAGS, *report['workloadCommand']],
            'Wrapper differs from the reviewed capture class')


def derive_observations(report, before, after, native):
    """Derive metrics only after the caller has verified exact original bytes."""
    require(type(report.get('schemaVersion')) is int and report['schemaVersion'] == 1
            and report.get('captureClass') == 'diagnostic-linux-cgroup-capture'
            and report.get('resourceAdmission') is False and report.get('performanceAccepted') is False,
            'Wrong original capture class')
    require(report.get('status') == 'captured', 'Rejected capture cannot supply joined resource observations')
    verify_boundaries(report, before, after)
    collector_wait = report['originalCollectorWait']
    require(collector_wait['method'] == 'atomic-wait4-collector', 'Original atomic collector wait is required')
    require(type(collector_wait['process']) is int and collector_wait['process'] == report['collectorProcess'],
            'Collector wait process differs')
    require(type(collector_wait['status']) is int and collector_wait['status'] >= 0
            and (os.WIFEXITED(collector_wait['status']) or os.WIFSIGNALED(collector_wait['status']))
            and type(collector_wait['exitCode']) is int
            and os.waitstatus_to_exitcode(collector_wait['status']) == collector_wait['exitCode'],
            'Invalid original collector terminal status')
    for name in ('userSeconds', 'systemSeconds', 'inclusiveMaximumRssKiB'):
        value = collector_wait[name]
        require(type(value) in (int, float) and math.isfinite(value) and value >= 0, 'Invalid collector usage field')
    leaf_identity = before['policy']['ancestorsLeafFirst'][0]['directoryIdentity']
    joined = native_summary(native, report['captureIdentity'], report['wrapperCommand'], leaf_identity,
                            before, after, collector_wait['process'])
    require(report['native'] == joined, 'Stored native summary differs from original bytes')
    last_wait = int(native['originalWait']['finishedNanoseconds'])
    for wait in native['adoptedWaits']:
        require(last_wait <= int(wait['startedNanoseconds']), 'Adopted waits are not in original consuming order')
        last_wait = int(wait['finishedNanoseconds'])
    require(collector_wait['exitCode'] == (0 if native['cleanObservedTeardown'] else 1),
            'Collector terminal outcome differs from its published native record')
    require(int(native['after']['finishedNanoseconds']) <= int(collector_wait['finishedNanoseconds'])
            <= int(after['startedNanoseconds']) and int(collector_wait['startedNanoseconds'])
            <= int(collector_wait['finishedNanoseconds']), 'Original collector wait/capture intervals differ')
    natural_drain = native['schemaVersion'] == 2
    expected_invocation = [before['tools']['collector']['path'], *(['--natural-drain'] if natural_drain else []), before['policy']['leaf'],
                           report['nativeReceipt']['path'], report['captureIdentity'],
                           str(report['timeoutMilliseconds']), *report['wrapperCommand']]
    require(report['collectorCommand'] == expected_invocation, 'Collector invocation differs from original boundaries')
    if natural_drain:
        require(int(native['commandDeadlineNanoseconds']) == int(native['cloneStartedNanoseconds'])
                + report['timeoutMilliseconds'] * 1000000, 'Natural-drain deadline differs from original timeout')

    cpu = {key: int(value) for key, value in (line.split(' ') for line in native['after']['cpuStat'].splitlines())}
    events = {key: int(value) for key, value in (line.split(' ') for line in native['after']['events'].splitlines())}
    reasons = []
    for failed, reason in (
        (report['outerCleanupRequired'] or bool(report['collectorSignals']), 'Outer collector cleanup was required'),
        (native['timedOut'], 'Native command timed out'),
        (native['interruptedSignal'] != 0, 'Native collector was interrupted'),
        (native['groupKilled'], 'Collector killed cgroup processes'),
        (native['survivorsAfterOwner'] not in ((0, 1) if natural_drain else (0,)),
         'Membership remained after the original wrapper exited'),
        (not native['noRemainingChildren'] or native['cleanupError'], 'Native child drain failed'),
        (not native['finalLeaf'] or events['populated'] != 0 or native['after']['processes'] != '', 'Final leaf was not empty'),
        (native['adoptedChildren'] != len(native['adoptedWaits']), 'Adopted terminal-wait inventory is truncated'),
    ):
        if failed:
            reasons.append(reason)
    start = int(native['cloneStartedNanoseconds'])
    end = int(native['after']['finishedNanoseconds'])
    require(start <= end, 'Reversed command interval')
    workload_clock = report.get('workloadClock')
    if workload_clock is not None:
        require(workload_clock['schemaVersion'] == 1 and workload_clock['type'] == 'monotonic'
                and workload_clock['implementation'] == native['clock'] and workload_clock['identity'] == report['captureIdentity']
                and int(before['finishedNanoseconds']) <= int(workload_clock['originNanoseconds']) <= start
                and type(workload_clock['resolutionSeconds']) in (int, float)
                and math.isfinite(workload_clock['resolutionSeconds']) and workload_clock['resolutionSeconds'] > 0,
                'Invalid original workload clock bridge')
    return {
        'schemaVersion': 1, 'status': 'verified-local-observations', 'accountingClass': ACCOUNTING_CLASS,
        'captureIdentity': report['captureIdentity'], 'resourceAdmission': False, 'performanceAccepted': False,
        'clock': 'clock_gettime(CLOCK_MONOTONIC)',
        'workloadClock': workload_clock,
        'hostIdentitySha256': before['host']['identitySha256'],
        'bootIdentitySha256': before['host']['bootIdentitySha256'],
        'commandInterval': {'startedNanoseconds': str(start), 'finishedNanoseconds': str(end),
                            'elapsedNanoseconds': str(end - start)},
        'cgroupCpu': {name: str(cpu[key]) for name, key in
                      (('usageMicroseconds', 'usage_usec'), ('userMicroseconds', 'user_usec'),
                       ('systemMicroseconds', 'system_usec'))},
        'cgroupChargedPeakBytes': str(int(native['after']['memoryPeak'])),
        'observedDrainedMembership': not reasons, 'drainRejectionReasons': reasons,
        'nativeCleanObservedTeardown': native['cleanObservedTeardown'],
        'adoptedChildren': native['adoptedChildren'], 'adoptedWaits': native['adoptedWaits'],
        'teardownPolicy': native.get('teardownPolicy', 'immediate-cleanup-after-owner-v1'),
        'originalWrapperWait': native['originalWait'], 'originalCollectorWait': collector_wait,
        'wrapperExitCode': native['originalWait']['exitCode'],
        'limitations': [
            'Kernel charges follow membership; closed workload scope, migrations, foreign ingress and external services require independent admission.',
            'Observed drained membership permits exited adopted children and is not the native clean-teardown flag or a workload-success claim.',
            'The interval includes wrapper execution and terminal drain; outside collector CPU and boundary inventory hashing are excluded.',
            'Charged memory includes kernel/file charges and shared-cache ownership effects; it is not concurrent RSS or total memory accessed.',
            'Stable raw boundary files do not authenticate their producer or prove complete input inventory or transient policy stability.',
            'The macOS owner-wait/RSS adapter and its regression thresholds are not applicable to this accounting class.'
        ]
    }


def read_resources(path):
    path = Path(path).resolve(strict=True)
    original, report = read_record(path, inputs.MAXIMUM_SNAPSHOT_BYTES)
    directory = path.parent
    before_receipt, before = member(directory, report['before'], 'before.json', inputs.MAXIMUM_SNAPSHOT_BYTES)
    after_receipt, after = member(directory, report['after'], 'after.json', inputs.MAXIMUM_SNAPSHOT_BYTES)
    native_receipt, native = member(directory, report['nativeReceipt'], 'native.json', MAXIMUM_NATIVE_BYTES)
    result = derive_observations(report, before, after, native)
    result['originalFiles'] = {'capture': original, 'before': before_receipt, 'after': after_receipt, 'native': native_receipt}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    args = parser.parse_args()
    try:
        result = read_resources(args.report)
    except (ValueError, OSError, KeyError, StopIteration, TypeError) as error:
        result = {'schemaVersion': 1, 'status': 'rejected', 'accountingClass': ACCOUNTING_CLASS,
                  'resourceAdmission': False, 'performanceAccepted': False,
                  'error': {'type': type(error).__name__, 'message': str(error)}}
    print(inputs.encode(result).decode(), end='')
    return 0 if result['status'] == 'verified-local-observations' else 1


if __name__ == '__main__':
    sys.exit(main())
