"""Native selector-handle reservations, cancellation and malformed wire requests."""

import os
import signal
import threading

from test_driver_protocol import OwnedDriverCase
from output_limits import expect_resource_error


class ElementResolutionTests(OwnedDriverCase):
    def selector(self, text="button", **options):
        encoded = text.encode("utf-16-le")
        units = [encoded[index] + 256 * encoded[index + 1] for index in range(0, len(encoded), 2)]
        return {"page": self.page, "frame": self.frame, "selector": units, "strict": True, "state": "attached", **options}

    def create_button(self):
        self.request("page.evaluate", self.evaluation("document.body.innerHTML = '<button>owned</button>'"))

    def handle_parameters(self, result):
        return {"page": self.page, "handle": result["handles"][0]["identifier"]}

    def test_pending_resolution_respects_handle_bound_and_hidden_wait_uses_no_slot(self):
        self.create_button()
        parent = self.request("page.evaluateHandle", self.evaluation("Object.fromEntries(Array.from({ length: 4095 }, (_, index) => [index, { index }]))"))
        children = self.request("handle.getProperties", self.handle_parameters(parent))
        error = expect_resource_error(self, "frame.waitForSelector", self.selector())
        self.assertIn("4096", error["message"])
        hidden = self.request("frame.waitForSelector", self.selector("#absent", state="hidden"))
        self.assertEqual(hidden["handles"], [])
        self.request("handle.dispose", self.handle_parameters(children))
        selected = self.request("frame.waitForSelector", self.selector())
        self.assertTrue(selected["handles"][0]["element"])
        self.request("handle.discard", {"page": self.page, "group": selected["group"]})
        self.request("frame.waitForSelector", self.selector())

    def test_cancelled_observation_releases_pending_slot_and_preserves_sibling(self):
        self.create_button()
        selected = self.request("frame.waitForSelector", self.selector())
        self.request("handle.dispose", self.handle_parameters(selected))
        sibling = self.request("context.newPage", {"context": self.context})["identifier"]
        os.kill(self.browser_process, signal.SIGSTOP)
        resume = threading.Timer(0.2, lambda: os.kill(self.browser_process, signal.SIGCONT))
        resume.start()
        try:
            command = self.command("frame.waitForSelector", self.selector(), timeout=40)
            self.send(command)
            reply = self.receive()
            self.assertEqual(reply["requestId"], command["requestId"])
            self.assertEqual(reply["error"]["code"], "TimeoutError", reply)
        finally:
            resume.join(timeout=2)
            os.kill(self.browser_process, signal.SIGCONT)
        self.assertEqual(self.request("page.evaluate", {**self.evaluation("42"), "page": sibling}), {"kind": "number", "value": 42})
        selected = self.request("frame.waitForSelector", self.selector())
        self.request("handle.dispose", self.handle_parameters(selected))
        parent = self.request("page.evaluateHandle", self.evaluation("Object.fromEntries(Array.from({ length: 4095 }, (_, index) => [index, { index }]))"))
        self.assertEqual(len(self.request("handle.getProperties", self.handle_parameters(parent))["handles"]), 4095)

    def test_bad_wire_options_and_repeated_missing_timeouts_do_not_retain_handles(self):
        self.create_button()
        for options in [{"state": "stable"}, {"strict": "true"}, {"unknown": True}, {"selector": [65536]}]:
            command = self.command("frame.waitForSelector", self.selector(**options))
            self.send(command)
            self.assertEqual(self.receive()["error"]["code"], "InvalidArgumentError")
        for _attempt in range(4):
            command = self.command("frame.waitForSelector", self.selector("#absent"), timeout=50)
            self.send(command)
            self.assertEqual(self.receive()["error"]["code"], "TimeoutError")
        parent = self.request("page.evaluateHandle", self.evaluation("Object.fromEntries(Array.from({ length: 4095 }, (_, index) => [index, { index }]))"))
        self.assertEqual(len(self.request("handle.getProperties", self.handle_parameters(parent))["handles"]), 4095)
