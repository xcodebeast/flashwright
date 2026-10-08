"""Exercise a hung job and a detached browser-shaped descendant under the real supervisor."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from unittest.mock import patch
from tools.watchdog import cleanup_owned_processes, record_cpu_observation


class WatchdogLifecycleTests(unittest.TestCase):
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
