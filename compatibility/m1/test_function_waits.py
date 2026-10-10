"""Native predicate cancellation retains allocation custody without terminating application code."""

import os
import signal
import threading

from test_driver_protocol import OwnedDriverCase


class FunctionWaitLifetimeTests(OwnedDriverCase):
    def predicate(self, source, polling=None):
        return {**self.evaluation(source), "isFunction": True, "frame": self.frame, "polling": polling}

    def armed_wait(self, body, timeout=None):
        command = self.command("frame.waitForFunction", self.predicate(
            "() => { globalThis.functionWaitArmed = true; " + body + " }"), timeout=timeout)
        self.send(command)
        self.request("page.evaluate", self.evaluation(
            "new Promise(resolve => { const next = () => globalThis.functionWaitArmed ? resolve(true) : setTimeout(next, 0); next(); })"))
        return command

    def assert_error(self, command, code):
        reply = self.receive()
        self.assertEqual(reply["requestId"], command["requestId"], reply)
        self.assertEqual(reply["kind"], "error", reply)
        self.assertEqual(reply["error"]["code"], code, reply)
        return reply["error"]

    def test_malformed_native_polling_rejects_before_predicate_effects(self):
        for polling in [0, -1, "raf", False, {}, []]:
            pending = self.command("frame.waitForFunction", self.predicate(
                "() => { globalThis.invalidPollingExecuted = true; return 42; }", polling=polling))
            self.send(pending)
            self.assert_error(pending, "InvalidArgumentError")
        self.assertEqual(self.request("page.evaluate", self.evaluation("globalThis.invalidPollingExecuted")), {"kind": "undefined"})

    def test_never_settling_async_result_has_an_independently_abortable_wait(self):
        pending = self.armed_wait("return new Promise(() => {});")
        self.send({"kind": "cancel", "requestId": pending["requestId"]})
        error = self.assert_error(pending, "CancelledError")
        self.assertIn(error["cleanup"], ["functionWaitGroupDisposed", "functionWaitCancellationPending"])
        self.assertEqual(self.request("page.evaluate", self.evaluation("42")), {"kind": "number", "value": 42})

    def test_late_async_resolution_cannot_publish_a_cancelled_handle(self):
        pending = self.armed_wait("return new Promise(resolve => { globalThis.resolveFunctionWait = resolve; });")
        self.send({"kind": "cancel", "requestId": pending["requestId"]})
        self.assert_error(pending, "CancelledError")
        self.request("page.evaluate", self.evaluation("resolveFunctionWait({ late: true })"))
        successor = self.request("frame.waitForFunction", self.predicate("() => 42"))
        self.assertEqual(self.request("handle.jsonValue", {"page": self.page, "handle": successor["handles"][0]["identifier"]}), {"kind": "number", "value": 42})
        self.request("handle.discard", {"page": self.page, "group": successor["group"]})

    def test_cancelled_polling_does_not_terminate_an_unrelated_blocking_evaluation(self):
        pending = self.armed_wait("return false;")
        busy = self.command("page.evaluate", self.evaluation(
            "(() => { const start = performance.now(); while (performance.now() - start < 300) {} globalThis.unrelatedWorkCompleted = true; return true; })()"))
        self.send(busy)
        cancellation = threading.Timer(0.05, lambda: self.send({"kind": "cancel", "requestId": pending["requestId"]}))
        cancellation.start()
        try:
            self.assert_error(pending, "CancelledError")
            reply = self.receive()
            self.assertEqual(reply["requestId"], busy["requestId"], reply)
            self.assertEqual(reply["value"], {"kind": "boolean", "value": True}, reply)
            self.assertEqual(self.request("page.evaluate", self.evaluation("unrelatedWorkCompleted")), {"kind": "boolean", "value": True})
        finally:
            cancellation.join()

    def test_timed_out_controller_creation_never_starts_the_predicate_after_recovery(self):
        self.request("page.evaluate", self.evaluation("42"))
        os.kill(self.browser_process, signal.SIGSTOP)
        try:
            expired = self.command("frame.waitForFunction", self.predicate("() => { globalThis.expiredPredicateExecuted = true; return 42; }"), timeout=100)
            self.send(expired)
            error = self.assert_error(expired, "TimeoutError")
            self.assertIn(error["cleanup"], ["functionWaitGroupDisposed", "functionWaitCancellationPending"])
        finally:
            os.kill(self.browser_process, signal.SIGCONT)
        self.assertEqual(self.request("page.evaluate", self.evaluation("globalThis.expiredPredicateExecuted")), {"kind": "undefined"})

    def test_handle_exhaustion_rejects_before_predicate_execution_and_disposal_restores_admission(self):
        parent = self.request("page.evaluateHandle", self.evaluation("Object.fromEntries(Array.from({ length: 4095 }, (_, index) => [index, {}]))"))
        properties = self.request("handle.getProperties", {"page": self.page, "handle": parent["handles"][0]["identifier"]})
        self.assertEqual(len(properties["handles"]), 4095)
        rejected = self.command("frame.waitForFunction", self.predicate("() => { globalThis.rejectedPredicateExecuted = true; return 42; }"))
        self.send(rejected)
        self.assert_error(rejected, "ResourceLimitError")
        self.assertEqual(self.request("page.evaluate", self.evaluation("globalThis.rejectedPredicateExecuted")), {"kind": "undefined"})
        self.request("handle.discard", {"page": self.page, "group": properties["group"]})
        successor = self.request("frame.waitForFunction", self.predicate("() => 42"))
        self.request("handle.discard", {"page": self.page, "group": successor["group"]})
        self.request("handle.discard", {"page": self.page, "group": parent["group"]})

    def test_parent_closure_settles_the_wait_without_late_success(self):
        pending = self.armed_wait("return new Promise(() => {});")
        closure = self.command("context.close", {"context": self.context})
        self.send(closure)
        replies = {reply["requestId"]: reply for reply in [self.receive(), self.receive()]}
        self.assertEqual(set(replies), {pending["requestId"], closure["requestId"]})
        self.assertEqual(replies[pending["requestId"]]["kind"], "error")
        self.assertEqual(replies[pending["requestId"]]["error"]["code"], "TargetClosedError")
        self.assertEqual(replies[closure["requestId"]]["kind"], "result")


class FunctionWaitPublicationTests(OwnedDriverCase):
    resource_limits = {"controlFrameBytes": 32768}

    def test_unpublishable_handle_runs_once_and_discards_its_original_group(self):
        parameters = {**self.evaluation("() => { globalThis.predicateEffects = (globalThis.predicateEffects || 0) + 1; return 'x'.repeat(12000); }"), "isFunction": True, "frame": self.frame, "polling": None}
        pending = self.command("frame.waitForFunction", parameters)
        self.send(pending)
        reply = self.receive()
        self.assertEqual(reply["requestId"], pending["requestId"], reply)
        self.assertEqual(reply["error"]["code"], "ResourceLimitError", reply)
        self.assertEqual(reply["error"]["cleanup"], "handleGroupDisposed", reply)
        self.assertEqual(self.request("page.evaluate", self.evaluation("predicateEffects")), {"kind": "number", "value": 1})
