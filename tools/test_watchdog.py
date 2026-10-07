"""Exercise a hung job and a detached browser-shaped descendant under the real supervisor."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class WatchdogLifecycleTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
