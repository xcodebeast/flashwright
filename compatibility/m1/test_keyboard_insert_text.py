"""Native text insertion validates before input and never replays cancelled delivery."""

from test_driver_protocol import OwnedDriverCase


class KeyboardInsertTextTests(OwnedDriverCase):
    def prepare_input(self):
        self.request("page.evaluate", self.evaluation("document.body.innerHTML = '<input>'; globalThis.inputs = 0; globalThis.keydowns = 0; document.querySelector('input').focus(); document.addEventListener('input', () => inputs++); document.addEventListener('keydown', () => keydowns++);"))

    def test_native_validation_rejects_before_input(self):
        self.prepare_input()
        cases = [
            ({"textUnits": [97, 55296]}, "UnsupportedFeatureError"),
            ({"textUnits": [65536]}, "InvalidArgumentError"),
            ({"textUnits": "text"}, "InvalidArgumentError"),
            ({"textUnits": [97], "delay": 1}, "UnsupportedFeatureError"),
        ]
        for parameters, code in cases:
            with self.subTest(parameters=parameters):
                command = self.command("keyboard.insertText", {"page": self.page, **parameters})
                self.send(command)
                reply = self.receive()
                self.assertEqual(reply["requestId"], command["requestId"], reply)
                self.assertEqual(reply["error"]["code"], code, reply)
        observed = self.request("page.evaluate", self.evaluation("document.querySelector('input').value === '' && inputs === 0 && keydowns === 0"))
        self.assertEqual(observed, {"kind": "boolean", "value": True})

    def test_queued_timeout_cannot_dispatch_after_input_lock_releases(self):
        self.prepare_input()
        held = self.command("keyboard.type", {"page": self.page, "textUnits": [97, 98], "delay": 5000})
        self.send(held)
        started = self.request("page.evaluate", self.evaluation("new Promise(resolve => { const observe = () => keydowns === 1 ? resolve(true) : setTimeout(observe, 10); observe(); })"))
        self.assertEqual(started, {"kind": "boolean", "value": True})
        queued = self.command("keyboard.insertText", {"page": self.page, "textUnits": [120]}, timeout=100)
        self.send(queued)
        reply = self.receive()
        self.assertEqual(reply["requestId"], queued["requestId"], reply)
        self.assertEqual(reply["error"]["code"], "TimeoutError", reply)
        self.assertEqual(reply["error"]["inputDelivery"], "notDispatched", reply)
        self.send({"kind": "cancel", "requestId": held["requestId"]})
        reply = self.receive()
        self.assertEqual(reply["requestId"], held["requestId"], reply)
        self.assertEqual(reply["error"]["code"], "CancelledError", reply)
        observed = self.request("page.evaluate", self.evaluation("document.querySelector('input').value === 'a' && inputs === 1"))
        self.assertEqual(observed, {"kind": "boolean", "value": True})

    def test_late_native_success_does_not_replay_cancelled_insertion(self):
        self.prepare_input()
        self.request("page.evaluate", self.evaluation("document.querySelector('input').addEventListener('beforeinput', () => { const finish = Date.now() + 350; while (Date.now() < finish) {} }, { once: true });"))
        command = self.command("keyboard.insertText", {"page": self.page, "textUnits": [97, 98, 99]}, timeout=100)
        self.send(command)
        reply = self.receive()
        self.assertEqual(reply["requestId"], command["requestId"], reply)
        self.assertEqual(reply["error"]["code"], "TimeoutError", reply)
        self.assertEqual(reply["error"]["inputDelivery"], "uncertain", reply)
        observed = self.request("page.evaluate", self.evaluation("document.querySelector('input').value === 'abc' && inputs === 1 && keydowns === 0"))
        self.assertEqual(observed, {"kind": "boolean", "value": True})
