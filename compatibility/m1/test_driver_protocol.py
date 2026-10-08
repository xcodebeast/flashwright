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
import threading
import unittest

from test_lifecycle import snapshot


class OwnedDriverCase(unittest.TestCase):
    driver_environment = {}
    resource_limits = {}
    create_initial_page = True

    def setUp(self):
        self.start_driver()
        browser = self.request("browser.launch", {"executablePath": os.environ["FLASHWRIGHT_BROWSER_PATH"]})
        self.browser = browser["identifier"]
        self.guardian = browser["processIdentifier"]
        context = self.request("browser.newContext", {"browser": self.browser})
        self.context = context["identifier"]
        if self.create_initial_page:
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

    def start_driver(self):
        self.identities = {}
        self.profile = None
        self.events = []
        self.limits = {"controlFrameBytes": 8388608, "pendingOperations": 1024, "queuedMessages": 128, "valueDepth": 64, "valueNodes": 100000, "binaryAttachmentBytes": 33554432, "pendingAttachments": 2, **self.resource_limits}
        environment = {**os.environ, **self.driver_environment}
        environment = {name: value for name, value in environment.items() if value is not None}
        self.driver = subprocess.Popen([os.environ["FLASHWRIGHT_DRIVER_PATH"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0, env=environment)
        self.addCleanup(self.release_owned_browser)
        self.identifier = 0
        self.send({"kind": "handshake", "handshake": {"packageVersion": "0.0.0", "protocolVersion": 5, "capabilityInventoryVersion": 1, "limits": self.limits}})
        handshake = self.receive()
        runtime_digest = hashlib.sha256()
        for name in Path("packages/resident-runtime/sources.txt").read_text().splitlines():
            source = Path("packages/resident-runtime", name).read_bytes()
            runtime_digest.update(struct.pack("<Q", len(source)))
            runtime_digest.update(source)
        self.assertEqual(handshake["residentRuntimeSha256"], runtime_digest.hexdigest())
        self.assertEqual(handshake["handshake"]["limits"], self.limits)

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
        self.assertLessEqual(length, self.limits["controlFrameBytes"])
        message = json.loads(self.read_exact(length))
        if message["kind"] == "event":
            self.assertIn("target", message)
            self.events.append(message)
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
    def test_cancelled_cold_evaluation_does_not_own_shared_preparation(self):
        # No evaluation has run in this page. Hold the helper's real CDP reply
        # while one caller expires and another remains interested in the result.
        os.kill(self.browser_process, signal.SIGSTOP)
        try:
            expired = self.command("page.evaluate", self.evaluation("globalThis.expiredEvaluations = (globalThis.expiredEvaluations || 0) + 1"), timeout=100)
            survivor = self.command("page.evaluate", self.evaluation("globalThis.survivingEvaluations = (globalThis.survivingEvaluations || 0) + 1"))
            self.send(expired)
            self.send(survivor)
            reply = self.receive()
            self.assertEqual(reply["requestId"], expired["requestId"], reply)
            self.assertEqual(reply["error"]["code"], "TimeoutError")
            self.assertEqual(reply["error"]["cleanup"], "evaluationNotDispatched")
            self.assertIsNone(self.driver.poll())
        finally:
            os.kill(self.browser_process, signal.SIGCONT)
        reply = self.receive()
        self.assertEqual(reply["requestId"], survivor["requestId"], reply)
        self.assertEqual(reply["value"], {"kind": "number", "value": 1})
        result = self.request("page.evaluate", self.evaluation("[globalThis.expiredEvaluations || 0, globalThis.survivingEvaluations || 0]"))
        self.assertEqual([item["value"] for item in result["items"]], [0, 1])

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


class StorageProtocolTests(OwnedDriverCase):
    def test_cookie_read_timeout_leaves_context_reusable(self):
        os.kill(self.browser_process, signal.SIGSTOP)
        try:
            pending = self.command("context.cookies", {"context": self.context}, timeout=100)
            self.send(pending)
            result = self.receive()
            self.assertEqual(result["requestId"], pending["requestId"])
            self.assertEqual(result["error"]["code"], "TimeoutError")
        finally:
            os.kill(self.browser_process, signal.SIGCONT)
        self.assertEqual(self.request("context.cookies", {"context": self.context}), [])
        self.assertEqual(self.request("page.evaluate", self.evaluation("42")), {"kind": "number", "value": 42})

    def test_uncertain_cookie_mutation_retires_only_its_context(self):
        survivor = self.request("browser.newContext", {"browser": self.browser})["identifier"]
        os.kill(self.browser_process, signal.SIGSTOP)
        # Let the deadline retire the owner, then release the genuine Chromium replies
        # inside the independent disposal budget. There is no mutation replay.
        resume = threading.Timer(0.25, lambda: os.kill(self.browser_process, signal.SIGCONT))
        resume.start()
        try:
            pending = self.command("context.addCookies", {"context": self.context, "cookies": [{"name": "late", "value": "value", "domain": "example.test", "path": "/"}]}, timeout=100)
            self.send(pending)
            result = self.receive()
            self.assertEqual(result["requestId"], pending["requestId"])
            self.assertEqual(result["error"]["code"], "TimeoutError")
            self.assertEqual(result["error"]["cleanup"], "resourceDisposed")
        finally:
            resume.join()
        self.send(self.command("context.cookies", {"context": self.context}))
        self.assertEqual(self.receive()["error"]["code"], "TargetClosedError")
        self.assertEqual(self.request("context.storageState", {"context": survivor}), {"cookies": [], "origins": []})
        self.request("context.newPage", {"context": survivor})

    def test_context_close_interrupts_cookie_read_without_waiting_for_browser(self):
        os.kill(self.browser_process, signal.SIGSTOP)
        try:
            pending = self.command("context.cookies", {"context": self.context})
            self.send(pending)
            closing = self.command("context.close", {"context": self.context})
            self.send(closing)
            result = self.receive()
            self.assertEqual(result["requestId"], pending["requestId"])
            self.assertEqual(result["error"]["code"], "TargetClosedError")
        finally:
            os.kill(self.browser_process, signal.SIGCONT)
        result = self.receive()
        self.assertEqual(result["requestId"], closing["requestId"])
        self.assertEqual(result["kind"], "result")


class ResidentAssertionProtocolTests(OwnedDriverCase):
    # Exercise default registration and cleanup even inside an explicit off-mode run.
    driver_environment = {"FLASHWRIGHT_RESIDENT_ASSERTIONS": None, "FLASHWRIGHT_CONDITION_INSTRUMENTATION": "1"}

    def assertion(self, value):
        request = json.dumps({"selector": "css=p", "expectedText": [{"string": value, "normalizeWhiteSpace": True}]})
        return {"page": self.page, "frame": self.frame, "expression": "to.have.text", "isNot": False, "request": [unit for unit, in struct.iter_unpack("<H", request.encode("utf-16-le"))]}

    def prepare_assertions(self):
        self.request("page.evaluate", self.evaluation("document.body.innerHTML = '<p>Ready</p>'"))
        return self.request("assertion.run", self.assertion("Ready"))["conditionMetrics"]

    def assert_no_live_conditions(self, metrics):
        for name in ["activeConditions", "observedRoots", "queuedDiscovery", "queuedConditions"]:
            self.assertEqual(metrics[name], 0, (name, metrics))
        self.assertEqual(metrics["cachedSelectorPrefixes"], 0)
        for name in ["fallbackSchedulingQueued", "animationFrameScheduled", "fallbackTimerScheduled", "deadlineTimerScheduled", "discoveryTimerScheduled", "flushMicrotaskScheduled", "flushTaskScheduled", "flushChannelOpen", "selectorBatchActive"]:
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
    def run_scenario(self, scenario):
        subprocess.run([os.environ["FLASHWRIGHT_TEST_NODE"], "compatibility/m1/client-deadline.mjs", scenario], check=True, timeout=10)

    def test_late_browser_launch_is_disposed(self):
        self.run_scenario("browser.launch")

    def test_late_context_allocation_is_disposed(self):
        self.run_scenario("browser.newContext")

    def test_late_page_allocation_is_disposed(self):
        self.run_scenario("context.newPage")

    def test_late_handle_allocations_are_disposed(self):
        for method in ["page.evaluateHandle", "frame.evaluateHandle", "handle.evaluateHandle", "handle.getProperty", "handle.getProperties"]:
            with self.subTest(method=method):
                self.run_scenario(method)

    def test_late_input_acknowledgement_is_preserved(self):
        self.run_scenario("locator.acknowledged")

    def test_late_undispatched_input_is_preserved(self):
        self.run_scenario("locator.notDispatched")

    def test_late_input_error_preserves_utf16_diagnostics(self):
        self.run_scenario("locator.error")

    def test_late_assertion_result_preserves_observation(self):
        self.run_scenario("assertion.result")

    def test_late_assertion_error_preserves_observation(self):
        self.run_scenario("assertion.error")

    def test_missing_capability_rejects_before_browser_allocation(self):
        self.run_scenario("handshake.capabilityMismatch")


if __name__ == "__main__":
    unittest.main()
