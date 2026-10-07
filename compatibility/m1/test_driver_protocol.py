"""Corrupt and backpressured real-driver streams must release owned Chromium resources."""

import hashlib
import json
import os
from pathlib import Path
import re
import select
import signal
import struct
import subprocess
import time
import unittest

from test_lifecycle import snapshot


class OwnedDriverCase(unittest.TestCase):
    driver_environment = {}

    def setUp(self):
        self.identities = {}
        self.profile = None
        self.driver = subprocess.Popen([os.environ["FLASHWRIGHT_DRIVER_PATH"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0, env={**os.environ, **self.driver_environment})
        self.addCleanup(self.release_owned_browser)
        self.identifier = 0
        self.send({"kind": "handshake", "handshake": {"packageVersion": "0.0.0", "protocolVersion": 4, "capabilityInventoryVersion": 1, "limits": {"controlFrameBytes": 8388608, "pendingOperations": 1024, "queuedMessages": 128, "valueDepth": 64, "valueNodes": 100000}}})
        handshake = self.receive()
        runtime_digest = hashlib.sha256()
        for name in Path("packages/resident-runtime/sources.txt").read_text().splitlines():
            source = Path("packages/resident-runtime", name).read_bytes()
            runtime_digest.update(struct.pack("<Q", len(source)))
            runtime_digest.update(source)
        self.assertEqual(handshake["residentRuntimeSha256"], runtime_digest.hexdigest())
        browser = self.request("browser.launch", {"executablePath": os.environ["FLASHWRIGHT_BROWSER_PATH"]})
        self.browser = browser["identifier"]
        self.guardian = browser["processIdentifier"]
        context = self.request("browser.newContext", {"browser": self.browser})
        self.context = context["identifier"]
        page = self.request("context.newPage", {"context": self.context})
        self.page = page["identifier"]
        self.frame = page["mainFrame"]
        processes = snapshot()
        owned = {self.guardian}
        while descendants := {process for process, (parent, _) in processes.items() if parent in owned} - owned:
            owned.update(descendants)
        self.identities = {process: processes[process][1] for process in owned}
        self.browser_process = next(process for process, (parent, _) in processes.items() if parent == self.guardian)
        command = subprocess.check_output(["ps", "-p", str(self.browser_process), "-o", "command="], text=True)
        self.profile = Path(re.search(r"--user-data-dir=(\S+)", command).group(1))

    def release_owned_browser(self):
        """A dead driver releases its liveness pipe; let the guardian finish cleanup."""
        try:
            if self.driver.poll() is None:
                self.driver.kill()
            self.driver.wait(timeout=5)
            self.assert_resources_released()
        finally:
            self.driver.stdin.close()
            self.driver.stdout.close()

    def send(self, message):
        body = json.dumps(message).encode()
        frame = struct.pack("<I", len(body)) + body
        while frame:
            frame = frame[os.write(self.driver.stdin.fileno(), frame):]

    def read_exact(self, length):
        result = bytearray()
        deadline = time.monotonic() + 15
        while len(result) < length:
            ready, _, _ = select.select([self.driver.stdout], [], [], max(0, deadline - time.monotonic()))
            self.assertTrue(ready, "driver reply exceeded external deadline")
            chunk = os.read(self.driver.stdout.fileno(), length - len(result))
            self.assertTrue(chunk, "driver closed its output before the reply completed")
            result.extend(chunk)
        return result

    def receive(self):
        length, = struct.unpack("<I", self.read_exact(4))
        self.assertLessEqual(length, 8388608)
        message = json.loads(self.read_exact(length))
        if message["kind"] == "event":
            self.assertIn("target", message)
            return self.receive()
        return message

    def command(self, method, parameters, timeout=None):
        self.identifier += 1
        return {"kind": "command", "requestId": self.identifier, "method": method, "parameters": parameters, "timeoutMilliseconds": timeout}

    def request(self, method, parameters):
        self.send(self.command(method, parameters))
        reply = self.receive()
        self.assertEqual(reply["kind"], "result", reply)
        return reply["value"]

    def assert_resources_released(self):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            processes = snapshot()
            remaining = [process for process, identity in self.identities.items() if process in processes and processes[process][1] == identity]
            if not remaining:
                if self.profile is not None:
                    self.assertFalse(self.profile.exists())
                return
            time.sleep(0.05)
        self.fail(f"driver stream failure left owned resources: {remaining}")

    def evaluation(self, source):
        return {"page": self.page, "source": [unit for unit, in struct.iter_unpack("<H", source.encode("utf-16-le", errors="surrogatepass"))], "isFunction": False, "argument": {"kind": "undefined"}}


class DriverProtocolTests(OwnedDriverCase):
    def test_malformed_frame_releases_browser(self):
        os.write(self.driver.stdin.fileno(), struct.pack("<I", 8388609))
        self.assertNotEqual(self.driver.wait(timeout=8), 0)
        self.assert_resources_released()

    def test_duplicate_request_while_renderer_is_blocked_releases_browser(self):
        message = self.command("page.evaluate", self.evaluation("while (true) {}"))
        self.send(message)
        self.send(message)
        self.assertNotEqual(self.driver.wait(timeout=8), 0)
        self.assert_resources_released()

    def test_eof_inside_frame_releases_browser(self):
        os.write(self.driver.stdin.fileno(), struct.pack("<I", 100) + b'{"kind":')
        self.driver.stdin.close()
        self.assertNotEqual(self.driver.wait(timeout=8), 0)
        self.assert_resources_released()

    def test_blocked_output_exhaustion_still_releases_browser(self):
        # No stdout reads after this request: its large reply fills the real OS pipe.
        self.send(self.command("page.evaluate", self.evaluation("'x'.repeat(30000)")))
        self.assertTrue(select.select([self.driver.stdout], [], [], 5)[0], "large reply never started")
        for _ in range(300):
            try:
                self.send(self.command("unsupported", {}))
            except BrokenPipeError:
                break
        self.assertNotEqual(self.driver.wait(timeout=8), 0)
        self.assert_resources_released()

    def test_cancelled_allocation_with_unresponsive_browser_reports_cleanup(self):
        os.kill(self.browser_process, signal.SIGSTOP)
        self.send(self.command("browser.newContext", {"browser": self.browser}, timeout=100))
        reply = self.receive()
        self.assertEqual(reply["kind"], "error", reply)
        self.assertEqual(reply["error"]["code"], "TimeoutError")
        # The reply is bounded independently of guardian completion; the process/profile
        # barrier below remains mandatory for either documented successful cleanup path.
        self.assertIn(reply["error"]["cleanup"], ["browserClosedAfterUnknownAllocation", "guardianContinuingCleanup"])
        self.assert_resources_released()
        self.driver.stdin.close()
        self.assertEqual(self.driver.wait(timeout=5), 0)


class ResidentAssertionProtocolTests(OwnedDriverCase):
    driver_environment = {"FLASHWRIGHT_RESIDENT_ASSERTIONS": "1", "FLASHWRIGHT_CONDITION_INSTRUMENTATION": "1"}

    def assertion(self, value):
        request = json.dumps({"selector": "css=p", "expectedText": [{"string": value, "normalizeWhiteSpace": True}]})
        return {"page": self.page, "frame": self.frame, "expression": "to.have.text", "isNot": False, "request": [unit for unit, in struct.iter_unpack("<H", request.encode("utf-16-le"))]}

    def prepare_assertions(self):
        self.request("page.evaluate", self.evaluation("document.body.innerHTML = '<p>Ready</p>'"))
        return self.request("assertion.run", self.assertion("Ready"))["conditionMetrics"]

    def assert_no_live_conditions(self, metrics):
        for name in ["activeConditions", "observedRoots", "queuedDiscovery"]:
            self.assertEqual(metrics[name], 0, (name, metrics))
        for name in ["animationFrameScheduled", "fallbackTimerScheduled", "deadlineTimerScheduled", "discoveryTimerScheduled"]:
            self.assertFalse(metrics[name], (name, metrics))

    def wait_for_active_conditions(self, expected):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            metrics = self.request("assertion.run", self.assertion("Ready"))["conditionMetrics"]
            if metrics["activeConditions"] == expected:
                return metrics
            time.sleep(0.01)
        self.fail(f"resident registration did not reach {expected} active conditions: {metrics}")

    def test_explicit_cancellation_retains_diagnostics_and_releases_subscription(self):
        self.prepare_assertions()
        pending = self.command("assertion.run", self.assertion("Never"))
        self.send(pending)
        self.wait_for_active_conditions(1)
        self.send({"kind": "cancel", "requestId": pending["requestId"]})
        result = self.receive()
        self.assertEqual(result["requestId"], pending["requestId"])
        self.assertEqual(result["error"]["code"], "CancelledError", result)
        self.assertEqual(result["error"]["cleanup"], "residentConditionReleased")
        diagnostics = result["error"]["diagnostics"]
        self.assertFalse(diagnostics["matches"])
        self.assert_no_live_conditions(diagnostics["conditionMetrics"])
        after = self.request("assertion.run", self.assertion("Ready"))["conditionMetrics"]
        time.sleep(0.15)
        later = self.request("assertion.run", self.assertion("Ready"))["conditionMetrics"]
        self.assert_no_live_conditions(later)
        self.assertEqual(later["predicateEvaluations"], after["predicateEvaluations"] + 1)

    def test_unbounded_cancellation_during_blocked_renderer_finishes_after_recovery(self):
        self.prepare_assertions()
        pending = self.command("assertion.run", self.assertion("Never"))
        self.send(pending)
        self.wait_for_active_conditions(1)
        blocked = self.command("page.evaluate", self.evaluation("while (true) {}"), timeout=700)
        self.send(blocked)
        time.sleep(0.05)
        started = time.monotonic()
        self.send({"kind": "cancel", "requestId": pending["requestId"]})
        cancelled = self.receive()
        self.assertEqual(cancelled["requestId"], pending["requestId"], cancelled)
        self.assertEqual(cancelled["error"]["code"], "CancelledError")
        self.assertEqual(cancelled["error"]["cleanup"], "residentCancellationPending")
        self.assertLess(time.monotonic() - started, 0.5)
        recovered = self.receive()
        self.assertEqual(recovered["requestId"], blocked["requestId"])
        self.assertEqual(recovered["error"]["code"], "TimeoutError")
        after = self.request("assertion.run", self.assertion("Ready"))["conditionMetrics"]
        self.assert_no_live_conditions(after)
        time.sleep(0.15)
        later = self.request("assertion.run", self.assertion("Ready"))["conditionMetrics"]
        self.assertEqual(later["predicateEvaluations"], after["predicateEvaluations"] + 1)

    def test_page_closure_releases_deferred_cancellation_ownership(self):
        self.prepare_assertions()
        pending = self.command("assertion.run", self.assertion("Never"))
        self.send(pending)
        self.wait_for_active_conditions(1)
        blocked = self.command("page.evaluate", self.evaluation("while (true) {}"))
        self.send(blocked)
        time.sleep(0.05)
        self.send({"kind": "cancel", "requestId": pending["requestId"]})
        cancelled = self.receive()
        self.assertEqual(cancelled["requestId"], pending["requestId"])
        self.assertEqual(cancelled["error"]["cleanup"], "residentCancellationPending")
        closing = self.command("context.close", {"context": self.context})
        self.send(closing)
        replies = [self.receive(), self.receive()]
        by_identifier = {reply["requestId"]: reply for reply in replies}
        self.assertEqual(by_identifier[closing["requestId"]]["kind"], "result", replies)
        self.assertEqual(by_identifier[blocked["requestId"]]["error"]["code"], "TargetClosedError", replies)
        replacement = self.request("browser.newContext", {"browser": self.browser})
        page = self.request("context.newPage", {"context": replacement["identifier"]})
        self.page, self.frame = page["identifier"], page["mainFrame"]
        self.assert_no_live_conditions(self.prepare_assertions())


class ClientDeadlineTests(unittest.TestCase):
    def test_success_crossing_caller_deadline_is_disposed(self):
        subprocess.run([os.environ["FLASHWRIGHT_TEST_NODE"], "compatibility/m1/client-deadline.mjs"], check=True, timeout=10)


if __name__ == "__main__":
    unittest.main()
