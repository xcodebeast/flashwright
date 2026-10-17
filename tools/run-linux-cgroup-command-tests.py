#!/usr/bin/env python3
"""Run native cgroup launcher controls in one temporary delegated user service.

Usage: python3 tools/run-linux-cgroup-command-tests.py workbench/<fresh-directory>
Requires Linux x64, cc, cgroup v2 and a user systemd manager with delegation.
No host-wide resource settings change. All generated files stay in workbench.
"""
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = Path(__file__).resolve()
WAIT_FIXTURE = ROOT / 'tools/linux-cgroup-wait-fixture.c'
WAIT_MODES = ['wait-' + mode for mode in ['reaped', 'ignored', 'nocldwait',
              'subreaper-reaped', 'subreaper-ignored', 'subreaper-nocldwait']]
NATURAL_MODES = ['natural-finish', 'natural-timeout', 'natural-interrupt', 'natural-owner-budget', 'natural-success']


def save(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def cpu_for(seconds):
    end = time.process_time() + seconds
    while time.process_time() < end:
        pass


def worker(mode, directory, group, destination):
    directory = Path(directory)
    (directory / 'executed').write_text(str(os.getpid()))
    if mode in NATURAL_MODES:
        if mode == 'natural-success':
            return 0
        child = os.fork()
        if child == 0:
            os.setsid()
            if mode == 'natural-finish':
                cpu_for(.08)
                time.sleep(.1)
                os._exit(23)
            time.sleep(20)
            os._exit(0)
        (directory / 'child').write_text(str(child))
        if mode == 'natural-owner-budget':
            time.sleep(.15)
        return 7
    if mode == 'tree':
        cpu_for(.06)
        for _ in range(12):
            child = os.fork()
            if child == 0:
                cpu_for(.005)
                os._exit(0)
            assert os.waitpid(child, 0)[1] == 0
    elif mode == 'exit-seven':
        return 7
    elif mode == 'signal-exit':
        os.kill(os.getpid(), signal.SIGTERM)
    elif mode in ['timeout', 'interrupt', 'live-orphan', 'dead-orphan']:
        child = os.fork()
        if child == 0:
            os.setsid()
            if mode == 'dead-orphan':
                cpu_for(.07)
                (directory / 'child-finished').write_text(str(os.getpid()))
                os._exit(0)
            time.sleep(20)
            os._exit(0)
        (directory / 'child').write_text(str(child))
        if mode == 'dead-orphan':
            until = time.monotonic() + 3
            while not (directory / 'child-finished').exists():
                assert time.monotonic() < until
                time.sleep(.001)
            time.sleep(.02)  # Let it become a zombie without reaping it.
        elif mode != 'live-orphan':
            time.sleep(20)
    elif mode == 'replace-path':
        alias = Path(group).parent
        alias.unlink()
        alias.symlink_to(directory / 'replacement-parent')
    elif mode == 'remove-counter':
        (Path(group).parent / 'cgroup.subtree_control').write_text('-memory')
    elif mode == 'escape':
        # An explicit negative control: endpoint emptiness cannot prove custody.
        Path(destination, 'cgroup.procs').write_text(str(os.getpid()))
        cpu_for(.1)
    elif mode not in ['success', 'ignored-sigchld']:
        raise ValueError(mode)
    return 0


def counters(text):
    pairs = [line.split() for line in text.splitlines()]
    assert all(len(pair) == 2 and pair[1].isdigit() for pair in pairs)
    assert len({pair[0] for pair in pairs}) == len(pairs)
    return {name: int(value) for name, value in pairs}


def deny_clone3():
    # Only this child and descendants inherit the fixture's syscall denial.
    class Filter(ctypes.Structure):
        _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte), ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint)]
    class Program(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ushort), ('filter', ctypes.POINTER(Filter))]
    instructions = (Filter * 4)(Filter(0x20, 0, 0, 0), Filter(0x15, 0, 1, 435),
                                Filter(0x06, 0, 0, 0x00050000 | errno.EPERM), Filter(0x06, 0, 0, 0x7fff0000))
    program = Program(4, instructions)
    library = ctypes.CDLL(None, use_errno=True)
    assert library.prctl(38, 1, 0, 0, 0) == 0
    assert library.prctl(22, 2, ctypes.byref(program), 0, 0) == 0


def delegated(directory):
    membership = Path('/proc/self/cgroup').read_text().strip()
    assert membership.startswith('0::/') and '\n' not in membership
    parent = Path('/sys/fs/cgroup') / membership[4:]
    assert parent.name == 'supervisor'
    (parent.parent / 'cgroup.subtree_control').write_text('+cpu +memory')
    collector = directory / 'collector'
    rows = []
    modes = ['tree', 'exit-seven', 'signal-exit', 'missing-executable', 'timeout', 'interrupt',
             'live-orphan', 'dead-orphan', 'replace-path', 'escape', 'remove-counter', 'ignored-sigchld', 'denied-clone', 'occupied-report',
             'used-group', 'nested-group', 'symlink-group', 'ordinary-directory']
    rejected_before_launch = set(modes[13:])
    modes += WAIT_MODES + NATURAL_MODES
    try:
        for mode in modes:
            out = directory / mode
            out.mkdir()
            group = parent.parent / mode
            group.mkdir()
            effective_group = group
            row = {'mode': mode, 'status': 'failed'}
            rows.append(row)
            try:
                output = out / 'receipt.json'
                if mode == 'replace-path':
                    alias = out / 'group-parent'
                    alias.symlink_to(parent.parent)
                    (out / 'replacement-parent' / mode).mkdir(parents=True)
                    effective_group = alias / mode
                if mode == 'occupied-report':
                    output.write_text('occupied')
                elif mode == 'used-group':
                    # Use the actual native launcher once; the second launch must fail before exec.
                    prior = subprocess.run([str(collector), str(group), str(out / 'prior.json'), uuid.uuid4().hex,
                                            '5000', sys.executable, '-c', 'sum(range(10000))'], timeout=8)
                    assert prior.returncode == 0
                elif mode == 'nested-group':
                    (group / 'nested').mkdir()
                elif mode == 'symlink-group':
                    effective_group = out / 'group-link'
                    effective_group.symlink_to(group)
                elif mode == 'ordinary-directory':
                    effective_group = out
                command = [sys.executable, str(SCRIPT), '--worker', mode if mode in modes[:12] + NATURAL_MODES else 'success',
                           str(out), str(effective_group), str(parent)]
                if mode == 'missing-executable':
                    command = [str(out / 'missing')]
                elif mode in WAIT_MODES:
                    command = [str(directory / 'wait-fixture'), mode.removeprefix('wait-')]
                duration = '150' if mode == 'timeout' else ('350' if mode in ['natural-timeout', 'natural-owner-budget'] else '5000')
                invocation = [str(collector), *(['--natural-drain'] if mode in NATURAL_MODES else []),
                              str(effective_group), str(output), uuid.uuid4().hex, duration, *command]
                row['command'] = invocation
                save(out / 'preflight.json', {name: (group / name).read_text() for name in ['cpu.stat', 'memory.peak', 'cgroup.events', 'cgroup.type', 'cgroup.procs']})
                with (out / 'stdout.txt').open('xb') as stdout, (out / 'stderr.txt').open('xb') as stderr:
                    preexec = deny_clone3 if mode == 'denied-clone' else ((lambda: signal.signal(signal.SIGCHLD, signal.SIG_IGN)) if mode == 'ignored-sigchld' else None)
                    process = subprocess.Popen(invocation, stdout=stdout, stderr=stderr, preexec_fn=preexec)
                    row['collectorProcess'] = process.pid
                    if mode in ['interrupt', 'natural-interrupt']:
                        until = time.monotonic() + 3
                        while not (out / 'child').exists():
                            assert process.poll() is None and time.monotonic() < until
                            time.sleep(.002)
                        if mode == 'natural-interrupt':
                            owner = int((out / 'executed').read_text())
                            while Path('/proc', str(owner)).exists():
                                assert process.poll() is None and time.monotonic() < until
                                time.sleep(.002)
                        process.send_signal(signal.SIGTERM)
                    row['exitCode'] = process.wait(timeout=10)
                    row['originalCollectorWait'] = True
                if mode in rejected_before_launch:
                    assert row['exitCode'] == (4 if mode == 'occupied-report' else 3), row
                    assert not (out / 'executed').exists()
                    if mode == 'occupied-report':
                        assert output.read_text() == 'occupied'
                    else:
                        assert not output.exists()
                else:
                    receipt = json.loads(output.read_text())
                    assert receipt['resourceAdmission'] is False
                    assert receipt['collectorProcess'] == process.pid
                    if mode == 'denied-clone':
                        assert row['exitCode'] == 1 and receipt['launchErrno'] == errno.EPERM
                        assert receipt['originalWait'] is None and not receipt['cleanObservedTeardown']
                        assert not (out / 'executed').exists()
                        assert receipt['afterValid'] and receipt['after']['processes'] == ''
                        row['status'] = 'passed'
                        continue
                    if mode == 'remove-counter':
                        assert row['exitCode'] == 1 and receipt['originalWait']['exitCode'] == 0
                        assert not receipt['afterValid'] and not receipt['cleanObservedTeardown']
                        assert receipt['after']['cpuStat'] and receipt['after']['memoryPeak'] == ''
                        assert receipt['noRemainingChildren']
                        row['status'] = 'passed'
                        continue
                    assert receipt['afterValid']
                    assert receipt['ownerProcess'] == receipt['originalWait']['process']
                    assert receipt['originalWait']['method'] == 'atomic-wait4-original-owner'
                    original_code = receipt['originalWait']['exitCode']
                    expected_code = {'exit-seven': 7, 'signal-exit': -15, 'missing-executable': 127,
                                     'timeout': -9, 'interrupt': -9}.get(mode, 0)
                    if mode in NATURAL_MODES and mode != 'natural-success':
                        expected_code = 7
                    assert original_code == expected_code, (mode, original_code)
                    assert receipt['noRemainingChildren'] and not receipt['cleanupError']
                    assert receipt['after']['processes'] == ''
                    assert counters(receipt['after']['events'])['populated'] == 0
                    assert counters(receipt['before']['cpuStat'])['usage_usec'] == 0
                    assert receipt['before']['memoryPeak'] == '0\n'
                    assert int(receipt['before']['finishedNanoseconds']) <= int(receipt['cloneStartedNanoseconds'])
                    assert int(receipt['cloneStartedNanoseconds']) <= int(receipt['originalWait']['startedNanoseconds'])
                    assert int(receipt['originalWait']['finishedNanoseconds']) <= int(receipt['after']['startedNanoseconds'])
                    assert receipt['adoptedChildren'] == len(receipt['adoptedWaits'])
                    if mode in NATURAL_MODES:
                        assert receipt['schemaVersion'] == 2
                        assert receipt['teardownPolicy'] == 'natural-drain-within-command-deadline-v1'
                        assert int(receipt['commandDeadlineNanoseconds']) == int(receipt['cloneStartedNanoseconds']) + int(duration) * 1000000
                        ordinary = mode == 'natural-success'
                        assert receipt['adoptedChildren'] == (0 if ordinary else 1)
                        assert receipt['cleanObservedTeardown'] == ordinary and row['exitCode'] == (0 if ordinary else 1)
                        forced = mode not in ['natural-finish', 'natural-success']
                        assert receipt['groupKilled'] == forced
                        assert receipt['timedOut'] == (mode in ['natural-timeout', 'natural-owner-budget'])
                        assert receipt['interruptedSignal'] == (15 if mode == 'natural-interrupt' else 0)
                        if not ordinary:
                            assert receipt['survivorsAfterOwner'] == 1
                            assert receipt['adoptedWaits'][0]['process'] == int((out / 'child').read_text())
                            assert os.waitstatus_to_exitcode(receipt['adoptedWaits'][0]['status']) == (-9 if forced else 23)
                        if mode == 'natural-finish':
                            assert int(receipt['after']['finishedNanoseconds']) - int(receipt['originalWait']['finishedNanoseconds']) >= 100000000
                            assert counters(receipt['after']['cpuStat'])['usage_usec'] >= 80000
                    elif mode in ['timeout', 'interrupt', 'live-orphan', 'dead-orphan']:
                        assert receipt['adoptedChildren'] == 1
                        assert receipt['adoptedWaits'][0]['process'] == int((out / 'child').read_text())
                        assert not receipt['cleanObservedTeardown'] and row['exitCode'] == 1
                        assert receipt['groupKilled'] == (mode != 'dead-orphan')
                    elif mode == 'replace-path':
                        assert not receipt['identityUnchanged'] and not receipt['cleanObservedTeardown']
                        assert row['exitCode'] == 1
                    else:
                        assert receipt['cleanObservedTeardown'] and row['exitCode'] == 0
                    if mode == 'timeout':
                        assert receipt['timedOut'] and receipt['interruptedSignal'] == 0
                    if mode == 'interrupt':
                        assert not receipt['timedOut'] and receipt['interruptedSignal'] == signal.SIGTERM
                    charged = counters(receipt['after']['cpuStat'])['usage_usec']
                    owner_cpu = receipt['originalWait']['userMicroseconds'] + receipt['originalWait']['systemMicroseconds']
                    row.update(cgroupCpuMicroseconds=charged, originalOwnerCpuMicroseconds=owner_cpu)
                    if mode == 'tree':
                        assert charged >= 110000 and owner_cpu >= 110000
                        assert abs(charged - owner_cpu) <= max(2000, charged * .02), row
                    if mode == 'dead-orphan':
                        assert charged - owner_cpu >= 60000, row
                    if mode == 'escape':
                        assert owner_cpu - charged >= 90000, row
                        row['coverageGapDemonstrated'] = 'Clean endpoints do not prove exclusive cgroup membership; resourceAdmission stays false.'
                    if mode in WAIT_MODES:
                        assert receipt['adoptedChildren'] == 0 and charged >= 80000, row
                        if mode.endswith('reaped'):
                            assert owner_cpu >= 80000 and abs(charged - owner_cpu) < 5000, row
                        else:
                            assert charged - owner_cpu >= 70000, row
                            row['coverageGapDemonstrated'] = 'Automatic child reaping loses wait CPU despite clean teardown and zero outer adoptions.'
                row['status'] = 'passed'
            finally:
                (parent.parent / 'cgroup.subtree_control').write_text('+cpu +memory')
                # Own only these exact fresh groups, including the deliberate rename control.
                for candidate in [group, group.with_name(group.name + '.moved')]:
                    if candidate.exists():
                        if counters((candidate / 'cgroup.events').read_text())['populated']:
                            (candidate / 'cgroup.kill').write_text('1')
                            until = time.monotonic() + 2
                            while counters((candidate / 'cgroup.events').read_text())['populated']:
                                assert time.monotonic() < until
                                time.sleep(.002)
                        nested = candidate / 'nested'
                        if nested.exists():
                            nested.rmdir()
                        candidate.rmdir()
                row['groupsRemoved'] = not group.exists() and not group.with_name(group.name + '.moved').exists()
            print(mode, row['status'], flush=True)
    finally:
        save(directory / 'native-results.json', {'rows': rows, 'expectedCases': len(modes), 'resourceAdmission': False})
    assert len(rows) == len(modes) and all(row['status'] == 'passed' and row['groupsRemoved'] for row in rows)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--worker':
        return worker(*sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] == '--delegated':
        delegated(Path(sys.argv[2]))
        return 0
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    assert sys.platform == 'linux' and platform.machine() == 'x86_64'
    directory = Path(sys.argv[1]).resolve()
    assert directory.is_relative_to(ROOT / 'workbench') and not directory.exists()
    directory.mkdir(parents=True)
    report = {'status': 'failed', 'resourceAdmission': False}
    unit = 'flashwright-cgroup-command-' + uuid.uuid4().hex + '.service'
    report['unit'] = unit
    subprocess.run(['cc', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
                    str(ROOT / 'tools/linux-cgroup-command.c'), '-o', str(directory / 'collector')], check=True, timeout=30)
    subprocess.run(['cc', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
                    str(WAIT_FIXTURE), '-o', str(directory / 'wait-fixture')], check=True, timeout=30)
    try:
        command = ['systemd-run', '--user', '--unit=' + unit, '--property=Type=exec',
                   '--property=RemainAfterExit=yes', '--property=Delegate=cpu memory',
                   '--property=DelegateSubgroup=supervisor', '--property=KillMode=control-group',
                   '--property=RuntimeMaxSec=45', '--property=WorkingDirectory=' + str(ROOT),
                   sys.executable, str(SCRIPT), '--delegated', str(directory)]
        report['command'] = command
        started = subprocess.run(command, capture_output=True, text=True, timeout=10)
        report['launch'] = {'exitCode': started.returncode, 'stdout': started.stdout, 'stderr': started.stderr}
        assert started.returncode == 0
        deadline = time.monotonic() + 50
        while time.monotonic() < deadline:
            state = subprocess.run(['systemctl', '--user', 'show', unit,
                                    '--property=ActiveState,SubState,Result,ExecMainStatus,ControlGroup'],
                                   capture_output=True, text=True, check=True, timeout=5).stdout
            report['terminalProperties'] = state
            if 'SubState=exited\n' in state or 'ActiveState=failed\n' in state:
                break
            time.sleep(.1)
        else:
            raise TimeoutError('Original delegated unit did not reach a terminal state')
        journal = subprocess.run(['journalctl', '--user', '-u', unit, '--no-pager', '-o', 'cat'],
                                 capture_output=True, text=True, timeout=10)
        (directory / 'unit-log.txt').write_text(journal.stdout + journal.stderr)
        assert 'Result=success\n' in state and 'ExecMainStatus=0\n' in state, state
        results = json.loads((directory / 'native-results.json').read_text())
        assert len(results['rows']) == results['expectedCases'] == 18 + len(WAIT_MODES) + len(NATURAL_MODES)
        assert all(row['status'] == 'passed' and row['groupsRemoved'] for row in results['rows'])
        report['status'] = 'passed-native-controls'
    finally:
        stopped = subprocess.run(['systemctl', '--user', 'stop', unit], capture_output=True, text=True, timeout=15)
        report['stop'] = {'exitCode': stopped.returncode, 'stderr': stopped.stderr}
        report['remainingCgroups'] = [str(p) for p in Path('/sys/fs/cgroup/user.slice', f'user-{os.getuid()}.slice').rglob(unit)]
        if stopped.returncode or report['remainingCgroups']:
            report['status'] = 'failed-cleanup'
        report['sources'] = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                             for p in [SCRIPT, ROOT / 'tools/linux-cgroup-command.c', WAIT_FIXTURE]}
        save(directory / 'controller.json', report)
    assert report['status'] == 'passed-native-controls', report
    print(f'{18 + len(WAIT_MODES) + len(NATURAL_MODES)} native controls passed; final resource admission remains separate.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
