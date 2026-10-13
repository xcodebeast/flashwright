"""Real process ownership tests, supervised by an outer watchdog in the npm test command."""

import json
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import time
import tempfile
import unittest
from collections import deque
from unittest.mock import patch


def snapshot():
    output = subprocess.check_output(["ps", "-axo", "pid=,ppid=,lstart="], text=True)
    return {int(fields[0]): (int(fields[1]), fields[2]) for line in output.splitlines() if len(fields := line.split(None, 2)) == 3}


def read_message(worker, timeout=40):
    ready, _, _ = select.select([worker.stdout], [], [], timeout)
    if not ready:
        raise AssertionError(f"worker did not report progress before the external deadline\n{diagnostic_tail(worker)}")
    line = worker.stdout.readline()
    if not line:
        raise AssertionError(f"worker exited early with status {worker.poll()}\n{diagnostic_tail(worker)}")
    return json.loads(line)


def diagnostic_tail(worker):
    diagnostics = getattr(worker, "diagnostics", None)
    if not diagnostics or diagnostics.closed:
        return ""
    diagnostics.seek(0)
    return diagnostics.read()[-8192:]


class OwnedBrowserCase(unittest.TestCase):
    worker_script = "compatibility/m1/lifecycle-worker.mjs"

    def setUp(self):
        self.identities = {}
        self.profile = None
        self.diagnostics = tempfile.TemporaryFile(mode="w+t")
        self.worker = subprocess.Popen([os.environ["FLASHWRIGHT_TEST_NODE"], self.worker_script], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.diagnostics, text=True, bufsize=1, start_new_session=True)
        self.addCleanup(self.release_owned_browser)
        self.worker.diagnostics = self.diagnostics
        message = read_message(self.worker)
        processes = snapshot()
        self.guardian = message.get("guardian") or next(process for process, (parent, _) in processes.items() if parent == message["driver"])
        self.driver = processes[self.guardian][0]
        self.owned = {self.driver, self.guardian}
        changed = True
        while changed:
            descendants = {process for process, (parent, _) in processes.items() if parent in self.owned}
            changed = bool(descendants - self.owned)
            self.owned.update(descendants)
        self.identities = {process: processes[process][1] for process in self.owned}
        self.browser_process = next(process for process, (parent, _) in processes.items() if parent == self.guardian)
        command = subprocess.check_output(["ps", "-p", str(self.browser_process), "-o", "command="], text=True)
        self.profile = Path(re.search(r"--user-data-dir=(\S+)", command).group(1))

    def release_owned_browser(self):
        """Worker death hands cleanup to the guardian, including after a failed setup/test.

        Killing the guardian here races its profile removal. Its normal ownership path
        must finish within the test budget; the outer watchdog contains a real failure.
        """
        try:
            if self.worker.poll() is None:
                self.worker.kill()
            self.worker.wait(timeout=5)
            self.assert_owned_processes_exit()
        finally:
            self.worker.stdin.close()
            self.worker.stdout.close()
            self.diagnostics.close()

    def assert_owned_processes_exit(self):
        started = time.monotonic()
        deadline = started + 8
        observations = deque(maxlen=8)
        remaining = list(self.identities)
        while time.monotonic() < deadline:
            processes = snapshot()
            remaining = [process for process, identity in self.identities.items() if process in processes and processes[process][1] == identity]
            observations.append({"elapsedSeconds": time.monotonic() - started, "remaining": remaining})
            if not remaining:
                if self.profile is not None:
                    self.assertFalse(self.profile.exists(), f"guardian left the owned browser profile behind: {self.profile}\n{diagnostic_tail(self.worker)}")
                return
            time.sleep(0.05)
        # A scheduling pause can make the last in-budget observation stale. Keep the
        # original failed deadline, but report a fresh observation separately.
        processes = snapshot()
        final_remaining = [process for process, identity in self.identities.items() if process in processes and processes[process][1] == identity]
        details = {
            "budgetSeconds": 8,
            "recentObservations": list(observations),
            "finalObservation": {"elapsedSeconds": time.monotonic() - started, "remaining": final_remaining},
            "profileExists": self.profile is not None and self.profile.exists(),
        }
        self.fail(f"owned process cleanup was not observed within its deadline: {json.dumps(details)}\n{diagnostic_tail(self.worker)}")

    def send(self, command):
        self.worker.stdin.write(command + "\n")
        self.worker.stdin.flush()

class EngineLifecycleTests(OwnedBrowserCase):
    def test_explicit_close_reaps_a_stopped_browser(self):
        os.kill(self.browser_process, signal.SIGSTOP)
        self.send("close")
        self.assertEqual(self.worker.wait(timeout=8), 0)
        self.assert_owned_processes_exit()

    def test_renderer_deadline_can_interrupt_infinite_javascript(self):
        self.send("blocked-renderer")
        self.assertTrue(read_message(self.worker, 5)["recovered"])
        self.send("close")
        self.assertEqual(self.worker.wait(timeout=5), 0)
        self.assert_owned_processes_exit()

    def test_driver_crash_does_not_orphan_browser(self):
        os.kill(self.driver, signal.SIGKILL)
        self.assert_owned_processes_exit()

    def test_dead_node_worker_releases_driver_and_browser(self):
        self.worker.kill()
        self.worker.wait(timeout=5)
        self.assert_owned_processes_exit()

    def test_dead_node_worker_with_stopped_driver_still_releases_browser(self):
        os.kill(self.driver, signal.SIGSTOP)
        self.worker.kill()
        self.worker.wait(timeout=5)
        self.assert_owned_processes_exit()

    def test_host_deadline_survives_stopped_driver(self):
        os.kill(self.driver, signal.SIGSTOP)
        self.send("driver-deadline")
        message = read_message(self.worker, 5)
        self.assertTrue(message["hostDeadline"])
        self.assertLess(message["elapsedMilliseconds"], 3000)
        self.assert_owned_processes_exit()


class DiagnosticPipeLifecycleTests(OwnedBrowserCase):
    def setUp(self):
        with patch.dict(os.environ, {"FLASHWRIGHT_DEBUG_OWNERSHIP": "1"}):
            super().setUp()

    def test_closed_diagnostic_pipe_cannot_interrupt_guardian_cleanup(self):
        # The Node worker is the only reader of the driver's inherited stderr pipe.
        # Its death must not turn a diagnostic write into a guardian panic.
        self.worker.kill()
        self.worker.wait(timeout=5)
        self.assert_owned_processes_exit()


class FailedCaseCleanupTests(unittest.TestCase):
    def test_failed_setup_and_test_body_release_profiles_without_killing_guardians(self):
        from test_driver_protocol import DriverProtocolTests

        for base in [OwnedBrowserCase, DriverProtocolTests]:
            for phase in ["setup", "test"]:
                with self.subTest(owner=base.__name__, phase=phase):
                    class DeliberatelyFailedCase(base):
                        def setUp(self):
                            super().setUp()
                            if phase == "setup":
                                self.fail("deliberate failure after browser allocation")

                        def runTest(self):
                            self.fail("deliberate failure with a live browser")

                    case = DeliberatelyFailedCase("runTest")
                    result = unittest.TestResult()
                    case.run(result)
                    self.assertEqual(len(result.failures), 1)
                    self.assertEqual(result.errors, [])
                    processes = snapshot()
                    remaining = [process for process, identity in case.identities.items() if process in processes and processes[process][1] == identity]
                    self.assertEqual(remaining, [])
                    self.assertFalse(case.profile.exists())


if __name__ == "__main__":
    unittest.main()
