"""Exercise a hung job and a detached browser-shaped descendant under the real supervisor."""

import errno
import json
import os
from pathlib import Path
import signal
import select
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from tools.watchdog import (OwnerExitNotification, RootProcessCpuAccounting, cleanup_owned_processes, main,
                           parse_linux_process_stat, process_snapshot, publish_report, record_cpu_observation)


class ReportPublicationTests(unittest.TestCase):
    def test_reader_never_observes_a_partially_serialized_report(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'report.json'
            partial = threading.Event()
            resume = threading.Event()
            failures = []
            report = {'samples': list(range(1000)), 'exitCode': 0}
            original_dump = json.dump

            def blocked_dump(value, handle, **kwargs):
                handle.write(' ')
                handle.flush()
                partial.set()
                if not resume.wait(5):
                    raise TimeoutError('Reader did not release writer')
                original_dump(value, handle, **kwargs)

            def writer():
                try:
                    publish_report(destination, report)
                except BaseException as error:
                    failures.append(error)

            with patch('tools.watchdog.json.dump', side_effect=blocked_dump):
                thread = threading.Thread(target=writer)
                thread.start()
                try:
                    self.assertTrue(partial.wait(5))
                    self.assertFalse(destination.exists())
                finally:
                    resume.set()
                    thread.join(5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(failures, [])
            self.assertEqual(json.loads(destination.read_text()), report)
            self.assertEqual(list(Path(directory).iterdir()), [destination])

    def test_a_competing_report_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'report.json'
            publish_report(destination, {'exitCode': 17})
            original = destination.read_bytes()
            with self.assertRaises(FileExistsError):
                publish_report(destination, {'exitCode': 0})
            self.assertEqual(destination.read_bytes(), original)
            self.assertEqual(list(Path(directory).iterdir()), [destination])

    def test_serialization_failure_publishes_nothing_and_removes_partial_file(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'report.json'
            with self.assertRaises(TypeError):
                publish_report(destination, {'samples': [0, object()]})
            self.assertEqual(list(Path(directory).iterdir()), [])


@unittest.skipUnless(sys.platform == 'linux', 'Linux native process counters')
class LinuxProcessSnapshotTests(unittest.TestCase):
    def test_native_fields_exclude_waited_child_cpu_and_parse_unusual_names(self):
        fields = ['0'] * 22
        for index, value in {0: 'S', 1: '41', 2: '42', 11: '7', 12: '18',
                             13: '9000', 14: '8000', 19: '12345', 21: '4'}.items():
            fields[index] = value
        stat = '123 (name with ) and\na newline) ' + ' '.join(fields)
        process, observed = parse_linux_process_stat(stat, 250, 16384, 0)
        self.assertEqual(process, 123)
        self.assertEqual(observed, {
            'parent': 41, 'group': 42, 'state': 'S', 'cpuSeconds': 0.1,
            'rssBytes': 65536, 'started': time.asctime(time.localtime(49)),
        })
        with self.assertRaises((ValueError, IndexError)):
            parse_linux_process_stat('123 (truncated) S 1', 250, 16384, 0)

    def test_subsecond_cpu_is_observed_before_the_child_exits(self):
        script = ('import time,sys; started=time.process_time()\n'
                  'while time.process_time()-started < 0.2: pass\n'
                  'print("ready",flush=True); sys.stdin.read()')
        with subprocess.Popen([sys.executable, '-c', script], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, text=True) as child:
            try:
                self.assertTrue(select.select([child.stdout], [], [], 5)[0])
                self.assertEqual(child.stdout.readline().strip(), 'ready')
                observed = process_snapshot()[child.pid]
                self.assertGreaterEqual(observed['cpuSeconds'], 0.19)
                self.assertEqual(observed['parent'], os.getpid())
                self.assertGreater(observed['rssBytes'], 0)
                started = subprocess.check_output(['ps', '-p', str(child.pid), '-o', 'lstart='], text=True).strip()
                self.assertEqual(observed['started'], started)
            finally:
                child.communicate(timeout=5)


class PollingChild:
    """Model Popen's POSIX wait lock and terminal status for syscall controls."""

    def __init__(self, process=101):
        self.pid = process
        self.returncode = None
        self._waitpid_lock = threading.Lock()

    def _handle_exitstatus(self, status):
        self.returncode = os.waitstatus_to_exitcode(status)


class OwnerExitNotificationTests(unittest.TestCase):
    def test_unavailable_platform_retains_disclosed_polling(self):
        notification = OwnerExitNotification(PollingChild())
        with patch('tools.watchdog.sys.platform', 'darwin'), patch('tools.watchdog.time.sleep') as sleep:
            notification.wait(0.1)
            notification.wait(0.05)
        self.assertEqual([call.args for call in sleep.call_args_list], [(0.1,), (0.05,)])
        self.assertEqual(notification.receipt, {'method': 'periodic-poll', 'reason': 'platform-unavailable'})
        notification.close()

    @unittest.skipUnless(hasattr(os, 'pidfd_open'), 'Process descriptor API')
    def test_denied_or_unavailable_pidfd_falls_back_once_and_discloses_reason(self):
        for code in (errno.ENOSYS, errno.EINVAL, errno.ENODEV, errno.EPERM, errno.EACCES, errno.ESRCH):
            with self.subTest(errno=code):
                notification = OwnerExitNotification(PollingChild())
                with patch('tools.watchdog.os.pidfd_open', side_effect=OSError(code, 'control')) as opened, \
                        patch('tools.watchdog.time.sleep') as sleep:
                    notification.wait(0.1)
                    notification.wait(0.1)
                opened.assert_called_once_with(101, 0)
                self.assertEqual(sleep.call_count, 2)
                self.assertEqual(notification.receipt, {'method': 'periodic-poll', 'reason': 'pidfd-unavailable', 'errno': code})
                notification.close()

    @unittest.skipUnless(hasattr(os, 'pidfd_open'), 'Process descriptor API')
    def test_unexpected_open_failure_is_not_silently_downgraded(self):
        notification = OwnerExitNotification(PollingChild())
        with patch('tools.watchdog.os.pidfd_open', side_effect=OSError(errno.EMFILE, 'control')), \
                patch('tools.watchdog.time.sleep') as sleep:
            with self.assertRaises(OSError):
                notification.wait(0.1)
            sleep.assert_not_called()
        notification.close()

    def test_already_reaped_owner_does_not_sleep_or_open_notification(self):
        child = PollingChild()
        child.returncode = 7
        notification = OwnerExitNotification(child)
        with patch('tools.watchdog.time.sleep') as sleep:
            notification.wait(1)
            sleep.assert_not_called()
        self.assertEqual(notification.receipt, {'method': 'not-used'})

    @unittest.skipUnless(hasattr(os, 'pidfd_open'), 'Process descriptor API')
    def test_poll_failure_closes_descriptor_and_main_still_cleans_owned_processes(self):
        child = PollingChild()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'report.json'
            with patch('sys.argv', ['watchdog', '--timeout', '5', '--report', str(path), '--', 'unused']), \
                    patch('tools.watchdog.subprocess.Popen', return_value=child), \
                    patch('tools.watchdog.os.wait4', return_value=(0, 0, None)), \
                    patch('tools.watchdog.process_snapshot', return_value={}), \
                    patch('tools.watchdog.adopt_orphaned_descendants', return_value=False), \
                    patch('tools.watchdog.signal.signal'), \
                    patch('tools.watchdog.os.pidfd_open', return_value=987), \
                    patch('tools.watchdog.select.poll') as poller, \
                    patch('tools.watchdog.os.close') as close, \
                    patch('tools.watchdog.cleanup_owned_processes', return_value=({}, [], {})) as cleanup:
                poller.return_value.poll.return_value = [(987, select.POLLNVAL)]
                with self.assertRaises(OSError):
                    main()
                close.assert_called_once_with(987)
                cleanup.assert_called_once()
            report = json.loads(path.read_text())
            self.assertEqual(report['ownerExitNotification']['error'], 'invalid-poll-events')
            self.assertEqual(report['rootPollCpu']['status'], 'not-observed')

    @unittest.skipUnless(sys.platform == 'linux' and hasattr(os, 'pidfd_open'), 'Linux process descriptor API')
    def test_native_exit_wakes_without_reaping_and_descriptor_closes(self):
        with subprocess.Popen([sys.executable, '-c', 'import sys; sys.stdin.read(); raise SystemExit(7)'],
                              stdin=subprocess.PIPE) as child:
            notification = OwnerExitNotification(child)
            accounting = RootProcessCpuAccounting(child, time.monotonic())
            descriptor = None
            try:
                notification.wait(0.01)
                if notification.receipt['method'] == 'periodic-poll':
                    self.skipTest('Native process descriptor unavailable: ' + repr(notification.receipt))
                self.assertEqual(notification.receipt, {'method': 'linux-pidfd-poll'})
                descriptor = notification.descriptor
                self.assertIsNone(accounting.poll())
                child.stdin.close()
                started = time.monotonic()
                notification.wait(5)
                self.assertLess(time.monotonic() - started, 2)
                self.assertIsNone(child.returncode, 'Notification must not reap')
                self.assertEqual(accounting.poll(), 7)
                self.assertEqual(accounting.receipt['status'], 'observed')
                self.assertEqual(accounting.receipt['method'], 'atomic-wait4-original-owner')
            finally:
                notification.close()
                notification.close()
                if child.returncode is None:
                    child.kill()
                    child.wait(timeout=5)
            with self.assertRaises(OSError) as closed:
                os.fstat(descriptor)
            self.assertEqual(closed.exception.errno, errno.EBADF)


class RootCpuAccountingTests(unittest.TestCase):
    def test_receipt_comes_only_from_the_original_owners_terminal_wait4(self):
        child = PollingChild()
        accounting = RootProcessCpuAccounting(child, time.monotonic())
        usage = SimpleNamespace(ru_utime=1.25, ru_stime=0.5, ru_maxrss=1024)
        with patch('tools.watchdog.os.wait4', side_effect=[(0, 0, None), (101, 17 << 8, usage)]) as wait:
            self.assertIsNone(accounting.poll())
            self.assertEqual(accounting.receipt['status'], 'not-observed')
            self.assertEqual(accounting.poll(), 17)
            receipt = dict(accounting.receipt)
            self.assertEqual(accounting.poll(), 17)
            self.assertEqual(wait.call_count, 2)
            self.assertTrue(all(call.args == (101, os.WNOHANG) for call in wait.call_args_list))
        self.assertEqual(accounting.receipt, receipt)
        self.assertEqual(receipt['status'], 'observed')
        self.assertEqual(receipt['method'], 'atomic-wait4-original-owner')
        self.assertEqual(receipt['waitStatus'], 17 << 8)
        self.assertEqual(receipt['cpuSeconds'], 1.75)
        self.assertEqual(receipt['inclusiveMaximumResidentBytes'], 1024 if sys.platform == 'darwin' else 1048576)
        self.assertNotIn('before', receipt)
        self.assertNotIn('after', receipt)
        self.assertGreater(int(receipt['reapedNanoseconds']), 0)
        self.assertGreaterEqual(receipt['finishedElapsedSeconds'], receipt['startedElapsedSeconds'])

    def test_nonterminal_and_interrupted_waits_do_not_publish_usage(self):
        child = PollingChild()
        accounting = RootProcessCpuAccounting(child, time.monotonic())
        usage = SimpleNamespace(ru_utime=1, ru_stime=1, ru_maxrss=1)
        with patch('tools.watchdog.os.wait4', side_effect=[InterruptedError(), (101, (signal.SIGSTOP << 8) | 0x7f, usage)]):
            self.assertIsNone(accounting.poll())
            self.assertIsNone(accounting.poll())
        self.assertIsNone(child.returncode)
        self.assertEqual(accounting.receipt['status'], 'not-observed')
        self.assertFalse(child._waitpid_lock.locked())

    def test_concurrent_wait_lock_never_reaps_or_invents_usage(self):
        child = PollingChild()
        accounting = RootProcessCpuAccounting(child, time.monotonic())
        with child._waitpid_lock, patch('tools.watchdog.os.wait4') as wait:
            self.assertIsNone(accounting.poll())
            wait.assert_not_called()
        self.assertEqual(accounting.receipt['status'], 'not-observed')

    def test_status_cached_by_another_reaper_never_fabricates_zero_cpu(self):
        with subprocess.Popen([sys.executable, '-c', 'raise SystemExit(7)']) as child:
            self.assertEqual(child.wait(timeout=5), 7)
            accounting = RootProcessCpuAccounting(child, time.monotonic())
            with patch('tools.watchdog.os.wait4') as wait:
                self.assertEqual(accounting.poll(), 7)
                wait.assert_not_called()
        self.assertEqual(accounting.receipt['status'], 'not-observed')
        self.assertNotIn('cpuSeconds', accounting.receipt)

    def test_external_waitpid_reports_unavailable_instead_of_observed_zero(self):
        with subprocess.Popen([sys.executable, '-c', 'raise SystemExit(7)']) as child:
            self.assertEqual(os.waitpid(child.pid, 0), (child.pid, 7 << 8))
            accounting = RootProcessCpuAccounting(child, time.monotonic())
            self.assertEqual(accounting.poll(), 0)
            self.assertEqual(accounting.receipt['status'], 'unavailable')
            self.assertEqual(accounting.receipt['reason'], 'original-owner-not-waitable')
        self.assertNotIn('cpuSeconds', accounting.receipt)

    def test_signal_exit_retains_actual_wait_status(self):
        with subprocess.Popen([sys.executable, '-c', 'import os,signal; os.kill(os.getpid(),signal.SIGKILL)']) as child:
            accounting = RootProcessCpuAccounting(child, time.monotonic())
            deadline = time.monotonic() + 5
            while accounting.poll() is None:
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.01)
            self.assertEqual(child.returncode, -signal.SIGKILL)
        self.assertEqual(accounting.receipt['status'], 'observed')
        self.assertTrue(os.WIFSIGNALED(accounting.receipt['waitStatus']))
        self.assertEqual(os.WTERMSIG(accounting.receipt['waitStatus']), signal.SIGKILL)

    def test_real_waited_descendant_cpu_survives_root_terminal_poll(self):
        leaf = 'import time; start=time.process_time()\nwhile time.process_time()-start < 0.2: pass'
        job = textwrap.dedent('''
            import json, resource, subprocess, sys
            subprocess.run([sys.executable, '-c', sys.argv[1]], check=True)
            usage = resource.getrusage(resource.RUSAGE_CHILDREN)
            print(json.dumps({'childCpuSeconds': usage.ru_utime + usage.ru_stime}))
        ''')
        with tempfile.TemporaryDirectory(prefix='flashwright-root-cpu-test-') as directory:
            path = Path(directory) / 'resources.json'
            result = subprocess.run([sys.executable, 'tools/watchdog.py', '--timeout', '5', '--report', str(path),
                '--', sys.executable, '-c', job, leaf], timeout=10, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(path.read_text())
            original = json.loads(result.stdout)
            self.assertGreaterEqual(original['childCpuSeconds'], 0.2)
            receipt = report['rootPollCpu']
            self.assertEqual(receipt['status'], 'observed')
            self.assertEqual(receipt['method'], 'atomic-wait4-original-owner')
            self.assertEqual(receipt['process'], report['ownerLaunch']['process'])
            self.assertEqual(receipt['exitCode'], 0)
            self.assertGreaterEqual(receipt['cpuSeconds'], original['childCpuSeconds'])
            self.assertEqual(receipt['cpuSeconds'], receipt['userSeconds'] + receipt['systemSeconds'])
            self.assertEqual(report['remainingObservedProcesses'], [])


class WatchdogLifecycleTests(unittest.TestCase):
    def test_root_exit_after_snapshot_preserves_its_observed_descendants(self):
        child = PollingChild()
        child.snapshot_taken = False

        def wait(process, options):
            self.assertEqual((process, options), (101, os.WNOHANG))
            return (101, 0, SimpleNamespace(ru_utime=0.5, ru_stime=0.25, ru_maxrss=1)) if child.snapshot_taken else (0, 0, None)

        def snapshot():
            child.snapshot_taken = True
            return {
                101: {"parent": os.getpid(), "group": 101, "rssBytes": 20, "cpuSeconds": 0.5, "state": "S", "started": "original-root"},
                102: {"parent": 101, "group": 102, "rssBytes": 30, "cpuSeconds": 0.25, "state": "S", "started": "original-child"},
            }

        with tempfile.TemporaryDirectory(prefix="flashwright-watchdog-snapshot-test-") as directory:
            path = Path(directory) / "report.json"
            with patch("sys.argv", ["watchdog", "--timeout", "5", "--report", str(path), "--", "unused"]), \
                    patch("tools.watchdog.subprocess.Popen", return_value=child), \
                    patch("tools.watchdog.os.wait4", side_effect=wait), \
                    patch("tools.watchdog.process_snapshot", side_effect=snapshot), \
                    patch("tools.watchdog.adopt_orphaned_descendants", return_value=False), \
                    patch("tools.watchdog.signal.signal"), patch("tools.watchdog.time.sleep"), \
                    patch("tools.watchdog.cleanup_owned_processes", return_value=({}, [], {})):
                self.assertEqual(main(), 0)
            report = json.loads(path.read_text())
            self.assertEqual({entry["process"] for entry in report["processes"]}, {101, 102})
            self.assertEqual(report["maximumSampledConcurrentRssBytes"], 50)
            self.assertEqual(report["observedCpuSeconds"], 0.75)

    def test_parent_exit_near_deadline_gives_promoted_child_a_fresh_grace_period(self):
        elapsed = [0.0]

        def observe():
            if elapsed[0] >= 3.6:
                return {}
            guardian = {"parent": 101 if elapsed[0] < 1.9 else 1, "started": "guardian", "state": "S"}
            if elapsed[0] < 1.9:
                return {101: {"parent": 1, "started": "owner", "state": "S"}, 102: guardian}
            return {102: guardian}

        def sleep(duration):
            elapsed[0] += duration

        def signal_owner(process, termination_signal):
            self.assertEqual(process, 101, "newly orphaned guardian lost its cleanup grace")
            self.assertEqual(termination_signal, signal.SIGTERM)

        with patch("tools.watchdog.time.monotonic", side_effect=lambda: elapsed[0]), \
                patch("tools.watchdog.time.sleep", side_effect=sleep), \
                patch("tools.watchdog.os.kill", side_effect=signal_owner):
            remaining, signals, cleanup = cleanup_owned_processes(observe, 101)
        self.assertEqual(remaining, {})
        self.assertEqual(len(signals), 1)
        self.assertFalse(cleanup["wholeTreeEscalation"])

    def test_zombie_owner_in_first_snapshot_still_gives_descendants_cleanup_grace(self):
        guardian = {"parent": 1, "started": "guardian", "state": "S"}
        snapshots = iter([
            {101: {"parent": 1, "started": "owner", "state": "Z"}, 102: guardian},
            {102: guardian},
            {},
        ])
        # The process query can observe the exited owner before Popen.poll reaps it.
        with patch("tools.watchdog.os.kill", side_effect=AssertionError("cleanup was interrupted")):
            remaining, signals, cleanup = cleanup_owned_processes(lambda: next(snapshots), 101)
        self.assertEqual(remaining, {})
        self.assertEqual(signals, [])
        self.assertFalse(cleanup["wholeTreeEscalation"])

    def test_cpu_reset_and_reused_process_identifiers_preserve_both_identities(self):
        records = {}
        record_cpu_observation(records, 101, {"started": "first", "cpuSeconds": 1.25})
        record_cpu_observation(records, 101, {"started": "first", "cpuSeconds": 0})
        record_cpu_observation(records, 101, {"started": "second", "cpuSeconds": 0.75})
        self.assertEqual(records[(101, "first")]["cpuSeconds"], 1.25)
        self.assertEqual(records[(101, "second")]["cpuSeconds"], 0.75)

    def test_timeout_kills_owned_descendants_and_preserves_an_unrelated_process(self):
        unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        try:
            with tempfile.TemporaryDirectory(prefix="flashwright-watchdog-test-") as directory:
                report_path = Path(directory) / "resources.json"
                identities_path = Path(directory) / "identities.json"
                job = (
                    "import subprocess,sys,time,os,json; "
                    "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],start_new_session=True); "
                    "open(sys.argv[1],'w').write(json.dumps([os.getpid(),child.pid])); "
                    "time.sleep(60)"
                )
                result = subprocess.run([
                    sys.executable, "tools/watchdog.py", "--timeout", "0.5", "--report", str(report_path),
                    "--", sys.executable, "-c", job, str(identities_path),
                ], timeout=20, capture_output=True, text=True)
                self.assertEqual(result.returncode, 124, result.stderr)
                report = json.loads(report_path.read_text())
                self.assertTrue(report["timedOut"])
                self.assertGreaterEqual(report["observedProcessCount"], 2)
                self.assertEqual(report["remainingObservedProcesses"], [])
                self.assertGreaterEqual(len(report["cleanupSignals"]), 2)
                self.assertIsNone(unrelated.poll())
                for process in json.loads(identities_path.read_text()):
                    with self.assertRaises(ProcessLookupError):
                        os.kill(process, 0)
        finally:
            unrelated.terminate()
            unrelated.wait(timeout=5)

    def test_clean_job_needs_no_watchdog_cleanup(self):
        with tempfile.TemporaryDirectory(prefix="flashwright-watchdog-test-") as directory:
            report_path = Path(directory) / "resources.json"
            result = subprocess.run([
                sys.executable, "tools/watchdog.py", "--timeout", "5", "--report", str(report_path),
                "--", sys.executable, "-c", "print('done')",
            ], timeout=10, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(report_path.read_text())
            self.assertEqual(report["cleanupSignals"], [])
            self.assertEqual(report["remainingObservedProcesses"], [])

    def test_clock_and_empty_sample_precede_original_child_execution(self):
        job = textwrap.dedent("""
            import json, os, pathlib, sys, time
            entered = time.monotonic_ns()
            clock = json.loads(os.environ['FLASHWRIGHT_WATCHDOG_CLOCK'])
            pathlib.Path(sys.argv[1]).write_text(json.dumps({
                'enteredNanoseconds': str(entered), 'clock': clock, 'process': os.getpid()
            }))
        """)
        with tempfile.TemporaryDirectory(prefix="flashwright-watchdog-clock-test-") as directory:
            report_path = Path(directory) / "resources.json"
            observation_path = Path(directory) / "child.json"
            result = subprocess.run([
                sys.executable, "tools/watchdog.py", "--timeout", "5", "--report", str(report_path),
                "--", sys.executable, "-c", job, str(observation_path),
            ], timeout=10, capture_output=True, text=True,
                env={**os.environ, "FLASHWRIGHT_WATCHDOG_CLOCK": "stale outer supervisor"})
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(report_path.read_text())
            observation = json.loads(observation_path.read_text())
            self.assertEqual(report["clock"], observation["clock"])
            self.assertEqual(report["clock"]["type"], "monotonic")
            self.assertEqual(report["ownerLaunch"]["process"], observation["process"])
            entered = (int(observation["enteredNanoseconds"]) - int(report["clock"]["originNanoseconds"])) / 1_000_000_000
            initial = report["samples"][0]
            self.assertEqual(initial["phase"], "before-owner-launch")
            self.assertEqual(initial["processes"], [])
            self.assertEqual(initial["concurrentRssBytes"], 0)
            self.assertEqual(initial["liveOwnedProcesses"], 0)
            self.assertGreaterEqual(report["ownerLaunch"]["startedElapsedSeconds"], initial["elapsedSeconds"])
            self.assertGreaterEqual(report["ownerLaunch"]["returnedElapsedSeconds"], report["ownerLaunch"]["startedElapsedSeconds"])
            self.assertGreaterEqual(entered, report["ownerLaunch"]["startedElapsedSeconds"])
            self.assertGreaterEqual(report["samples"][-1]["elapsedSeconds"], entered)
            self.assertGreaterEqual(report["elapsedSeconds"], report["samples"][-1]["elapsedSeconds"])
            for sample in report["samples"][1:]:
                self.assertGreaterEqual(sample["acquisitionStartedElapsedSeconds"], 0)
                self.assertGreaterEqual(sample["acquisitionFinishedElapsedSeconds"], sample["acquisitionStartedElapsedSeconds"])
                self.assertGreaterEqual(sample["elapsedSeconds"], sample["acquisitionFinishedElapsedSeconds"])
            self.assertEqual(report["cleanupSignals"], [])
            self.assertEqual(report["remainingObservedProcesses"], [])

    def test_parent_death_allows_delayed_descendant_cleanup(self):
        cleanup_child = textwrap.dedent("""
            import os, pathlib, shutil, sys, time
            os.read(int(sys.argv[1]), 1)
            time.sleep(0.8)
            shutil.rmtree(sys.argv[2])
        """)
        parent = textwrap.dedent("""
            import json, os, pathlib, signal, subprocess, sys, time
            profile = pathlib.Path(sys.argv[2])
            profile.mkdir()
            reader, writer = os.pipe()
            child = subprocess.Popen([sys.executable, '-c', sys.argv[1], str(reader), str(profile)],
                                     pass_fds=(reader,), start_new_session=True)
            os.close(reader)
            pathlib.Path(sys.argv[3]).write_text(json.dumps([os.getpid(), child.pid]))
            if sys.argv[4] == 'exit':
                time.sleep(0.2)
                sys.exit(17)
            if sys.argv[4] == 'stopped':
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                os.kill(os.getpid(), signal.SIGSTOP)
            time.sleep(60)
        """)
        for mode in ["exit", "timeout", "stopped", "interrupt"]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix="flashwright-watchdog-test-") as directory:
                report_path = Path(directory) / "resources.json"
                profile = Path(directory) / "owned-profile"
                identities_path = Path(directory) / "identities.json"
                supervisor = subprocess.Popen([
                    sys.executable, "tools/watchdog.py", "--timeout", "30" if mode == "interrupt" else "1",
                    "--report", str(report_path), "--", sys.executable, "-c", parent,
                    cleanup_child, str(profile), str(identities_path), mode,
                ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    if mode == "interrupt":
                        deadline = time.monotonic() + 5
                        while not identities_path.exists() and time.monotonic() < deadline:
                            time.sleep(0.05)
                        self.assertTrue(identities_path.exists())
                        supervisor.send_signal(signal.SIGINT)
                    output, diagnostics = supervisor.communicate(timeout=20)
                    self.assertEqual(supervisor.returncode, 17 if mode == "exit" else 130 if mode == "interrupt" else 124, diagnostics + output)
                    report = json.loads(report_path.read_text())
                    parent_process, child_process = json.loads(identities_path.read_text())
                    self.assertFalse(profile.exists())
                    self.assertEqual(report["remainingObservedProcesses"], [])
                    self.assertFalse(report["cleanup"]["wholeTreeEscalation"])
                    self.assertNotIn(child_process, [entry["process"] for entry in report["cleanupSignals"]])
                    if mode == "stopped":
                        self.assertIn({"process": parent_process, "signal": "SIGKILL"},
                                      [{"process": entry["process"], "signal": entry["signal"]} for entry in report["cleanupSignals"]])
                finally:
                    if supervisor.poll() is None:
                        supervisor.terminate()
                        supervisor.communicate(timeout=20)

    def test_deep_unresponsive_tree_reaches_bounded_whole_tree_escalation(self):
        job = textwrap.dedent("""
            import signal, subprocess, sys, time
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            depth = int(sys.argv[1])
            if depth:
                subprocess.Popen([sys.executable, '-c', sys.argv[2], str(depth - 1), sys.argv[2]], start_new_session=True)
            time.sleep(60)
        """)
        with tempfile.TemporaryDirectory(prefix="flashwright-watchdog-test-") as directory:
            report_path = Path(directory) / "resources.json"
            result = subprocess.run([
                sys.executable, "tools/watchdog.py", "--timeout", "1", "--report", str(report_path),
                "--", sys.executable, "-c", job, "6", job,
            ], timeout=20, capture_output=True, text=True)
            self.assertEqual(result.returncode, 124, result.stderr)
            report = json.loads(report_path.read_text())
            self.assertTrue(report["cleanup"]["wholeTreeEscalation"])
            self.assertEqual(report["remainingObservedProcesses"], [])
            self.assertGreaterEqual(report["observedProcessCount"], 7)
            self.assertLess(report["cleanup"]["elapsedSeconds"], 14)

    def test_cpu_records_retain_a_child_while_it_is_an_unreaped_zombie(self):
        with tempfile.TemporaryDirectory(prefix="flashwright-watchdog-cpu-test-") as directory:
            report_path = Path(directory) / "resources.json"
            job = (
                "import subprocess,sys,time; "
                "child=subprocess.Popen([sys.executable,'-c',"
                "'import time; end=time.process_time()+1.2\\nwhile time.process_time()<end: pass\\nprint(\"ready\",flush=True)'],stdout=subprocess.PIPE); "
                "print(child.pid,flush=True); child.stdout.readline(); time.sleep(0.6); child.wait(); time.sleep(0.3)"
            )
            result = subprocess.run([
                sys.executable, "tools/watchdog.py", "--timeout", "5", "--report", str(report_path),
                "--", sys.executable, "-c", job,
            ], timeout=10, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(report_path.read_text())
            child_process = int(result.stdout.strip())
            child_records = [record for record in report["processes"] if record["process"] == child_process]
            self.assertEqual(len(child_records), 1)
            self.assertGreater(child_records[0]["cpuSeconds"], 0.1)
            child_samples = [process["cpuSeconds"] for sample in report["samples"]
                             for process in sample["processes"] if process["process"] == child_process]
            self.assertEqual(child_records[0]["cpuSeconds"], max(child_samples))
            self.assertEqual(report["observedProcessCount"], len(report["processes"]))
            self.assertEqual(report["observedCpuSeconds"], sum(record["cpuSeconds"] for record in report["processes"]))
            self.assertEqual(report["maximumSampledConcurrentRssBytes"], max(sample["concurrentRssBytes"] for sample in report["samples"]))
            self.assertEqual(report["cleanupSignals"], [])
            self.assertEqual(report["remainingObservedProcesses"], [])


if __name__ == "__main__":
    unittest.main()
