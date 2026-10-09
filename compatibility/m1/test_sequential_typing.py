"""Typing validates before focus, releases cancelled keys and retires a blocked page only."""

import json

from test_driver_protocol import OwnedDriverCase


class SequentialTypingTests(OwnedDriverCase):
    def typing(self, text_units, delay=0):
        request = json.dumps({"selector": "input", "action": "pressSequentially"})
        return {"page": self.page, "frame": self.frame, "action": "pressSequentially", "request": list(request.encode()), "keyboard": {"textUnits": text_units, "delay": delay}}

    def prepare_input(self):
        self.request("page.evaluate", self.evaluation("document.body.innerHTML = '<input>'; globalThis.keys = []; for (const type of ['keydown','keyup']) document.addEventListener(type, event => keys.push([type, event.key, event.repeat]));"))
        self.request("locator.run", self.typing([]))

    def test_deadline_releases_key_and_does_not_replay_remaining_text(self):
        self.prepare_input()
        command = self.command("locator.run", self.typing([97, 98, 99], delay=5000), timeout=200)
        self.send(command)
        reply = self.receive()
        self.assertEqual(reply["requestId"], command["requestId"])
        self.assertEqual(reply["error"]["code"], "TimeoutError", reply)
        self.assertEqual(reply["error"]["inputDelivery"], "acknowledged", reply)
        self.assertEqual(reply["error"]["cleanup"], "keyboardReleased", reply)
        self.assertEqual(self.request("page.evaluate", self.evaluation("JSON.stringify(keys)")), {"kind": "string", "units": list(b'[["keydown","a",false],["keyup","a",false]]')})
        self.request("keyboard.type", {"page": self.page, "textUnits": [97]})
        self.assertEqual(self.request("page.evaluate", self.evaluation("document.querySelector('input').value")), {"kind": "string", "units": [97, 97]})
        self.assertEqual(self.request("page.evaluate", self.evaluation("keys.some(event => event[2])")), {"kind": "boolean", "value": False})

    def test_malformed_sequence_is_rejected_before_focus_or_input(self):
        self.prepare_input()
        self.request("page.evaluate", self.evaluation("document.querySelector('input').blur(); keys = [];"))
        for settings, code in [({"textUnits": [97, 55296]}, "UnsupportedFeatureError"), ({"textUnits": [65536]}, "InvalidArgumentError"), ({"textUnits": [97], "delay": -1}, "InvalidArgumentError"), ({"textUnits": [97], "unsupported": True}, "InvalidArgumentError")]:
            parameters = self.typing([])
            parameters["keyboard"] = settings
            self.send(self.command("locator.run", parameters))
            self.assertEqual(self.receive()["error"]["code"], code)
        self.assertEqual(self.request("page.evaluate", self.evaluation("document.activeElement === document.body && keys.length === 0 && document.querySelector('input').value === ''")), {"kind": "boolean", "value": True})

    def test_blocked_key_handler_closes_only_its_page(self):
        self.prepare_input()
        sibling = self.request("context.newPage", {"context": self.context})["identifier"]
        self.request("page.evaluate", self.evaluation("document.querySelector('input').addEventListener('keydown', () => { while (true) {} });"))
        self.send(self.command("locator.run", self.typing([97, 98]), timeout=200))
        reply = self.receive()
        self.assertEqual(reply["error"]["code"], "TimeoutError", reply)
        self.assertEqual(reply["error"]["inputDelivery"], "uncertain", reply)
        self.assertIn(reply["error"]["cleanup"], ["resourceDisposed", "resourceAlreadyDisposed"], reply)
        self.assertEqual(self.request("page.evaluate", {**self.evaluation("42"), "page": sibling}), {"kind": "number", "value": 42})
