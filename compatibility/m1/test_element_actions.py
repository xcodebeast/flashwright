"""Captured element actions own private aliases through bounds, cancellation and renderer failure."""

import json
import os
import signal
import threading

from test_driver_protocol import OwnedDriverCase
from output_limits import expect_resource_error


class ElementActionTests(OwnedDriverCase):
    def locator(self, action="selectText", selector="input", **options):
        encoded = json.dumps({"selector": selector, "action": action}, ensure_ascii=True)
        return {"page": self.page, "frame": self.frame, "action": action, "request": list(encoded.encode()), "element": options}

    def prepare_input(self):
        self.request("page.evaluate", self.evaluation("document.body.innerHTML = '<input value=owned><div style=height:2000px></div><button>bottom</button>';"))
        self.request("locator.run", self.locator())
        result = self.request("page.evaluateHandle", self.evaluation("document.querySelector('input')"))
        return {"page": self.page, "handle": result["handles"][0]["identifier"]}

    def test_private_actions_work_at_public_handle_limit_and_keep_borrowed_handle(self):
        handle = self.prepare_input()
        parent = self.request("page.evaluateHandle", self.evaluation("Object.fromEntries(Array.from({ length: 4094 }, (_, index) => [index, { index }]))"))
        self.assertEqual(len(self.request("handle.getProperties", {"page": self.page, "handle": parent["handles"][0]["identifier"]})["handles"]), 4094)
        expect_resource_error(self, "page.evaluateHandle", self.evaluation("({})"))
        for action in ["selectText", "scrollIntoViewIfNeeded"]:
            self.request("locator.run", self.locator(action))
            self.request(f"elementHandle.{action}", handle)
        self.assertEqual(self.request("handle.evaluate", {**self.evaluation("element => element.value"), "isFunction": True, **handle}), {"kind": "string", "units": list(b"owned")})
        expect_resource_error(self, "page.evaluateHandle", self.evaluation("({})"))
        self.request("handle.dispose", handle)
        self.request("page.evaluateHandle", self.evaluation("({ afterDisposal: true })"))

    def test_cancelled_scroll_has_no_late_effect_and_preserves_handle_and_sibling(self):
        handle = self.prepare_input()
        sibling = self.request("context.newPage", {"context": self.context})["identifier"]
        self.request("page.evaluate", self.evaluation("document.querySelector('input').style.position='absolute'; globalThis.position=0; function move(){document.querySelector('input').style.left=String(++position)+'px';globalThis.movement=requestAnimationFrame(move)};move();"))
        self.send(self.command("elementHandle.scrollIntoViewIfNeeded", handle, timeout=100))
        reply = self.receive()
        self.assertEqual(reply["error"]["code"], "TimeoutError", reply)
        self.assertEqual(reply["error"]["inputDelivery"], "notDispatched", reply)
        self.assertEqual(reply["error"]["cleanup"], "handleGroupDisposed", reply)
        self.request("page.evaluate", self.evaluation("cancelAnimationFrame(movement)"))
        self.request("elementHandle.scrollIntoViewIfNeeded", handle)
        self.request("elementHandle.selectText", handle)
        self.assertEqual(self.request("page.evaluate", {**self.evaluation("42"), "page": sibling}), {"kind": "number", "value": 42})
        self.request("handle.dispose", handle)
        parent = self.request("page.evaluateHandle", self.evaluation("Object.fromEntries(Array.from({ length: 4095 }, (_, index) => [index, { index }]))"))
        self.assertEqual(len(self.request("handle.getProperties", {"page": self.page, "handle": parent["handles"][0]["identifier"]})["handles"]), 4095)

    def test_cancelled_alias_adoption_keeps_original_handle(self):
        handle = self.prepare_input()
        os.kill(self.browser_process, signal.SIGSTOP)
        resume = threading.Timer(0.2, lambda: os.kill(self.browser_process, signal.SIGCONT))
        resume.start()
        try:
            self.send(self.command("elementHandle.selectText", handle, timeout=40))
            reply = self.receive()
            self.assertEqual(reply["error"]["code"], "TimeoutError", reply)
        finally:
            resume.join(timeout=2)
            os.kill(self.browser_process, signal.SIGCONT)
        self.request("elementHandle.selectText", handle)
        self.assertEqual(self.request("handle.evaluate", {**self.evaluation("element => element.selectionEnd"), "isFunction": True, **handle}), {"kind": "number", "value": 5})

    def test_malformed_options_reject_before_selection_and_missing_retries_release_groups(self):
        handle = self.prepare_input()
        self.request("page.evaluate", self.evaluation("document.querySelector('input').blur(); document.querySelector('input').setSelectionRange(1,1);"))
        malformed = [
            ("elementHandle.selectText", {**handle, "force": "yes"}, "InvalidArgumentError"),
            ("elementHandle.selectText", {**handle, "force": None}, "InvalidArgumentError"),
            ("elementHandle.scrollIntoViewIfNeeded", {**handle, "force": True}, "UnsupportedFeatureError"),
            ("locator.run", self.locator(force="yes"), "InvalidArgumentError"),
            ("locator.run", self.locator("scrollIntoViewIfNeeded", force=True), "UnsupportedFeatureError"),
            ("locator.run", {**self.locator(), "pointer": {}}, "InvalidArgumentError"),
            ("locator.run", {**self.locator(), "keyboard": {}}, "InvalidArgumentError"),
        ]
        for method, parameters, expected in malformed:
            self.send(self.command(method, parameters))
            self.assertEqual(self.receive()["error"]["code"], expected, (method, parameters))
        self.assertEqual(self.request("page.evaluate", self.evaluation("document.activeElement === document.body && document.querySelector('input').selectionStart === 1 && document.querySelector('input').selectionEnd === 1")), {"kind": "boolean", "value": True})
        for action in ["selectText", "scrollIntoViewIfNeeded"]:
            self.send(self.command("locator.run", self.locator(action, "#missing"), timeout=50))
            self.assertEqual(self.receive()["error"]["code"], "TimeoutError")
        self.request("elementHandle.selectText", handle)

    def test_blocked_selection_callback_is_not_replayed_and_sibling_survives(self):
        handle = self.prepare_input()
        sibling = self.request("context.newPage", {"context": self.context})["identifier"]
        self.request("page.evaluate", self.evaluation("document.querySelector('input').blur(); globalThis.selectionCount=0; document.querySelector('input').addEventListener('focus',()=>{selectionCount++;while(true){}});"))
        self.send(self.command("elementHandle.selectText", handle, timeout=200))
        reply = self.receive()
        self.assertEqual(reply["error"]["code"], "TimeoutError", reply)
        self.assertEqual(reply["error"]["inputDelivery"], "uncertain", reply)
        self.assertIn(reply["error"]["cleanup"], ["handleGroupDisposed", "handleContextDestroyed", "pageClosedAfterUncertainHandleCleanup"], reply)
        if reply["error"]["cleanup"] == "handleGroupDisposed":
            self.assertEqual(self.request("page.evaluate", self.evaluation("selectionCount")), {"kind": "number", "value": 1})
        self.assertEqual(self.request("page.evaluate", {**self.evaluation("42"), "page": sibling}), {"kind": "number", "value": 42})
