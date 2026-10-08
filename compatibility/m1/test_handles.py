"""Real native handle ownership under cancellation, publication limits and exhaustion."""

import os
import signal

from test_driver_protocol import OwnedDriverCase
from output_limits import expect_resource_error


class HandleLifetimeTests(OwnedDriverCase):
    def allocate(self, expression):
        return self.request("page.evaluateHandle", self.evaluation(expression))

    def handle_parameters(self, bundle):
        return {"page": self.page, "handle": bundle["handles"][0]["identifier"]}

    def test_handle_limit_rejects_before_user_code_and_disposal_reuses_slots(self):
        parent = self.allocate("Object.fromEntries(Array.from({ length: 4095 }, (_, index) => [index, { index }]))")
        properties = self.request("handle.getProperties", self.handle_parameters(parent))
        self.assertEqual(len(properties["handles"]), 4095)
        error = expect_resource_error(self, "page.evaluateHandle", self.evaluation("globalThis.rejectedHandleExecuted = true"))
        self.assertIn("4096", error["message"])
        self.assertEqual(self.request("page.evaluate", self.evaluation("globalThis.rejectedHandleExecuted")), {"kind": "undefined"})
        self.request("handle.dispose", self.handle_parameters(properties))
        successor = self.allocate("42")
        self.assertEqual(self.request("handle.jsonValue", self.handle_parameters(successor)), {"kind": "number", "value": 42})
        self.request("handle.dispose", self.handle_parameters(successor))
        self.request("handle.discard", {"page": self.page, "group": properties["group"]})
        self.assertEqual(self.request("handle.getProperties", self.handle_parameters(parent))["handles"][0]["element"], False)

    def test_partial_property_allocation_rolls_back_without_disposing_parent(self):
        parent = self.allocate("Object.fromEntries(Array.from({ length: 4096 }, (_, index) => [index, { index }]))")
        for _attempt in range(2):
            error = expect_resource_error(self, "handle.getProperties", self.handle_parameters(parent))
            self.assertIn("4096", error["message"])
            self.assertEqual(error["cleanup"], "handleGroupDisposed")
            property_handle = self.request("handle.getProperty", {**self.handle_parameters(parent), "name": [ord('0')]})
            self.assertEqual(self.request("handle.jsonValue", self.handle_parameters(property_handle))["entries"], [[[105, 110, 100, 101, 120], {"kind": "number", "value": 0}]])
            self.request("handle.dispose", self.handle_parameters(property_handle))

    def test_navigation_releases_destroyed_object_handle_slots(self):
        expression = "Object.fromEntries(Array.from({ length: 4095 }, (_, index) => [index, { index }]))"
        original = self.allocate(expression)
        self.request("handle.getProperties", self.handle_parameters(original))
        self.request("page.goto", {"page": self.page, "url": "data:text/html,<p>successor</p>", "waitUntil": "load"})
        successor = self.allocate(expression)
        self.assertEqual(len(self.request("handle.getProperties", self.handle_parameters(successor))["handles"]), 4095)
        self.send(self.command("handle.jsonValue", self.handle_parameters(original)))
        self.assertIn("execution context was destroyed", self.receive()["error"]["message"])
        self.request("handle.dispose", self.handle_parameters(original))

    def test_cancelled_cold_handle_evaluation_never_executes(self):
        os.kill(self.browser_process, signal.SIGSTOP)
        try:
            expired = self.command("page.evaluateHandle", self.evaluation("globalThis.expiredHandleExecuted = true"), timeout=100)
            self.send(expired)
            reply = self.receive()
            self.assertEqual(reply["requestId"], expired["requestId"])
            self.assertEqual(reply["error"]["code"], "TimeoutError")
            self.assertEqual(reply["error"]["cleanup"], "evaluationNotDispatched")
        finally:
            os.kill(self.browser_process, signal.SIGCONT)
        self.assertEqual(self.request("page.evaluate", self.evaluation("globalThis.expiredHandleExecuted")), {"kind": "undefined"})
        self.allocate("42")

    def test_timed_out_allocations_settle_or_retire_only_their_page(self):
        sibling = self.request("context.newPage", {"context": self.context})["identifier"]
        self.request("page.evaluate", self.evaluation("42"))
        for expression in ["(() => { while (true) {} })()", "new Promise(resolve => setTimeout(() => resolve({ late: true }), 2000))"]:
            command = self.command("page.evaluateHandle", self.evaluation(expression), timeout=100)
            self.send(command)
            reply = self.receive()
            self.assertEqual(reply["requestId"], command["requestId"])
            self.assertEqual(reply["error"]["code"], "TimeoutError", reply)
            self.assertIn(reply["error"]["cleanup"], ["handleGroupDisposed", "handleContextDestroyed", "pageClosedAfterUncertainHandleCleanup"])
            self.assertEqual(self.request("page.evaluate", {**self.evaluation("42"), "page": sibling}), {"kind": "number", "value": 42})
            if reply["error"]["cleanup"] != "handleGroupDisposed":
                self.page = self.request("context.newPage", {"context": self.context})["identifier"]
                self.request("page.evaluate", self.evaluation("42"))


class HandlePublicationTests(OwnedDriverCase):
    resource_limits = {"controlFrameBytes": 32768}

    def test_unpublishable_primitive_handle_runs_once_and_releases_its_group(self):
        error = expect_resource_error(self, "page.evaluateHandle", self.evaluation("(globalThis.handleEffects = (globalThis.handleEffects || 0) + 1, 'x'.repeat(12000))"))
        self.assertEqual(error["cleanup"], "handleGroupDisposed", error)
        self.assertEqual(self.request("page.evaluate", self.evaluation("handleEffects")), {"kind": "number", "value": 1})

    def test_rejected_property_publication_releases_all_children_and_keeps_parent(self):
        parent = self.request("page.evaluateHandle", self.evaluation("Object.fromEntries(Array.from({ length: 512 }, (_, index) => [index, { index }]))"))
        parameters = {"page": self.page, "handle": parent["handles"][0]["identifier"]}
        for _attempt in range(10):
            error = expect_resource_error(self, "handle.getProperties", parameters)
            self.assertNotIn("4096", error["message"], "rejected groups retained handle slots")
            self.assertEqual(error["cleanup"], "handleGroupDisposed", error)
        child = self.request("handle.getProperty", {**parameters, "name": [ord('0')]})
        self.assertEqual(child["handles"][0]["element"], False)
        self.request("handle.dispose", parameters)
        self.assertEqual(self.request("handle.jsonValue", {"page": self.page, "handle": child["handles"][0]["identifier"]})["entries"], [[[105, 110, 100, 101, 120], {"kind": "number", "value": 0}]])
