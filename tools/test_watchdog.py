"""Exercise a hung job and a detached browser-shaped descendant under the real supervisor."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from tools.watchdog import record_cpu_observation


class WatchdogLifecycleTests(unittest.TestCase):
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
                ], timeout=10, capture_output=True, text=True)
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
