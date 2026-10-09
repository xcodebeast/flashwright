"""Native chooser event ownership survives cancellation, late discard and handle exhaustion."""

import json
import os
import signal
import struct
import threading

from test_driver_protocol import OwnedDriverCase


class FileChooserTests(OwnedDriverCase):
    def prepare(self):
        self.request("page.evaluate", self.evaluation("document.body.innerHTML='<input type=file multiple>';globalThis.mainMarker='main';"))
        self.request("page.fileChooser.subscribe", {"page": self.page, "enabled": True})

    def chooser(self):
        before = len([event for event in self.events if event["event"] == "filechooser"])
        self.request("page.evaluate", self.evaluation("document.querySelector('input').click()"))
        for _ in range(100):
            choices = [event["parameters"] for event in self.events if event["event"] == "filechooser"]
            if len(choices) > before:
                return choices[-1]
            self.request("page.evaluate", self.evaluation("42"))
        self.fail("chooser adoption did not publish its event")

    def test_unobserved_chooser_group_does_not_interrupt_later_application_work(self):
        self.prepare()
        chooser = self.chooser()
        self.assertTrue(chooser["multiple"])
        handle = {"page": self.page, "handle": chooser["handles"][0]["identifier"]}
        self.assertEqual(self.request("handle.evaluate", {**self.evaluation("element=>globalThis.mainMarker===undefined && element.ownerDocument===document"), **handle, "isFunction": True}), {"kind": "boolean", "value": True})
        self.request("page.console.subscribe", {"page": self.page, "enabled": True})
        evaluation = self.command("page.evaluate", self.evaluation("(() => { console.log('busy'); const until=performance.now()+1200; while(performance.now()<until){} return 42; })()"))
        self.send(evaluation)
        while True:
            length, = struct.unpack("<I", self.read_exact(4))
            message = json.loads(self.read_exact(length))
            self.assertEqual(message["kind"], "event", message)
            if message["event"] == "console":
                break
        discard = self.command("handle.discard", {"page": self.page, "group": chooser["group"]})
        self.send(discard)
        replies = {reply["requestId"]: reply for reply in [self.receive(), self.receive()]}
        self.assertEqual(replies[discard["requestId"]]["kind"], "result", replies)
        self.assertEqual(replies[evaluation["requestId"]]["value"], {"kind": "number", "value": 42}, replies)
        self.request("handle.discard", {"page": self.page, "group": message["parameters"]["group"]})
        self.request("page.console.subscribe", {"page": self.page, "enabled": False})
        self.request("page.fileChooser.subscribe", {"page": self.page, "enabled": False})
        parent = self.request("page.evaluateHandle", self.evaluation("Object.fromEntries(Array.from({length:4095},(_,index)=>[index,{index}]))"))
        self.assertEqual(len(self.request("handle.getProperties", {"page": self.page, "handle": parent["handles"][0]["identifier"]})["handles"]), 4095)

    def test_cancelled_interception_wait_owns_its_late_acknowledgement(self):
        self.request("page.evaluate", self.evaluation("document.body.innerHTML='<input type=file>';"))
        sibling = self.request("context.newPage", {"context": self.context})["identifier"]
        os.kill(self.browser_process, signal.SIGSTOP)
        resume = threading.Timer(0.2, lambda: os.kill(self.browser_process, signal.SIGCONT))
        resume.start()
        try:
            self.send(self.command("page.fileChooser.subscribe", {"page": self.page, "enabled": True}, timeout=40))
            reply = self.receive()
            self.assertEqual(reply["error"]["code"], "TimeoutError", reply)
        finally:
            resume.join(timeout=2)
            os.kill(self.browser_process, signal.SIGCONT)
        self.request("page.fileChooser.subscribe", {"page": self.page, "enabled": False})
        self.request("page.fileChooser.subscribe", {"page": self.page, "enabled": True})
        chooser = self.chooser()
        self.request("handle.discard", {"page": self.page, "group": chooser["group"]})
        self.assertEqual(self.request("page.evaluate", {**self.evaluation("42"), "page": sibling}), {"kind": "number", "value": 42})

    def test_chooser_handle_exhaustion_reports_the_originating_limit_and_releases_browser(self):
        self.prepare()
        parent = self.request("page.evaluateHandle", self.evaluation("Object.fromEntries(Array.from({length:4095},(_,index)=>[index,{index}]))"))
        self.request("handle.getProperties", {"page": self.page, "handle": parent["handles"][0]["identifier"]})
        self.send(self.command("page.evaluate", self.evaluation("document.querySelector('input').click()")))
        reply = self.receive()
        if reply["kind"] == "result":
            reply = self.receive()
        self.assertEqual(reply["kind"], "error", reply)
        self.assertIsNone(reply["requestId"])
        self.assertEqual(reply["error"]["code"], "ResourceLimitError", reply)
        self.assertEqual(reply["error"]["method"], "page.fileChooser", reply)
        self.driver.wait(timeout=8)
        self.assert_resources_released()
