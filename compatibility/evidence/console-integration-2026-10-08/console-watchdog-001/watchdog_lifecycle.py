"""Exercise real browser ownership when the external job watchdog stops its owner."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

from test_lifecycle import OwnedBrowserCase, snapshot


def run_owned_job(mode, identities_path):
    tempfile.TemporaryFile = lambda mode: open(Path(__file__).parent / f"ownership-{os.getpid()}.log", mode)
    case = OwnedBrowserCase()
    case.setUp()
    if mode == "stopped-worker":
        os.kill(case.worker.pid, signal.SIGSTOP)
    elif mode == "stopped-driver":
        os.kill(case.driver, signal.SIGSTOP)
    identities = {
        "processes": {**case.identities, case.worker.pid: snapshot()[case.worker.pid][1]},
        "guardian": case.guardian, "profile": str(case.profile),
    }
    temporary = identities_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(identities))
    temporary.replace(identities_path)
    if mode == "clean":
        case.send("close")
        case.worker.wait(timeout=10)
        case.release_owned_browser()
        return 0
    if mode == "failed-owner":
        return 17
    time.sleep(90)
    raise AssertionError("the independent watchdog did not stop its owned job")


class BrowserWatchdogTests(unittest.TestCase):
    def exercise(self, mode):
        with tempfile.TemporaryDirectory(prefix="flashwright-watchdog-browser-") as directory:
            identities_path = Path(directory) / "identities.json"
            report_path = Path("compatibility/evidence/resources") / f"browser-watchdog-{mode}-{uuid.uuid4().hex}.json"
            supervisor = subprocess.Popen([
                sys.executable, "tools/watchdog.py", "--timeout", "30" if mode == "timeout" else "60",
                "--report", str(report_path), "--", sys.executable, __file__,
                "--owned-job", mode, str(identities_path),
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                deadline = time.monotonic() + (25 if mode == "timeout" else 45)
                while not identities_path.exists() and supervisor.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertTrue(identities_path.exists(), f"owned browser did not become ready in mode {mode}")
                identities = json.loads(identities_path.read_text())
                if mode in ["interrupt", "stopped-worker", "stopped-driver"]:
                    supervisor.send_signal(signal.SIGINT if mode == "interrupt" else signal.SIGTERM)
                output, diagnostics = supervisor.communicate(timeout=45)
                expected = 0 if mode == "clean" else 17 if mode == "failed-owner" else 124 if mode == "timeout" else 130
                self.assertEqual(supervisor.returncode, expected, diagnostics + output)
                report = json.loads(report_path.read_text())
                self.assertEqual(report["timedOut"], mode == "timeout")
                self.assertEqual(report["interrupted"], mode in ["interrupt", "stopped-worker", "stopped-driver"])
                self.assertEqual(report["remainingObservedProcesses"], [])
                self.assertFalse(report["cleanup"]["wholeTreeEscalation"])
                self.assertNotIn(identities["guardian"], [entry["process"] for entry in report["cleanupSignals"]])
                self.assertFalse(Path(identities["profile"]).exists(), diagnostics)
                processes = snapshot()
                self.assertEqual([process for process, started in identities["processes"].items()
                                  if int(process) in processes and processes[int(process)][1] == started], [])
                if mode == "clean":
                    self.assertEqual(report["cleanupSignals"], [])
            finally:
                if supervisor.poll() is None:
                    supervisor.terminate()
                supervisor.communicate(timeout=30)

    def test_normal_close(self):
        self.exercise("clean")

    def test_failed_job_owner(self):
        self.exercise("failed-owner")

    def test_job_timeout(self):
        self.exercise("timeout")

    def test_interrupted_job(self):
        self.exercise("interrupt")

    def test_stopped_worker(self):
        self.exercise("stopped-worker")

    def test_stopped_driver(self):
        self.exercise("stopped-driver")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--owned-job"]:
        raise SystemExit(run_owned_job(sys.argv[2], Path(sys.argv[3])))
    unittest.main()
