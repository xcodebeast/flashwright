"""Screencast start cancellation keeps a cleanup owner while Chromium is stopped."""

import os
import signal

from test_driver_protocol import OwnedDriverCase


class FilmstripTests(OwnedDriverCase):
    def test_cancelled_start_cannot_be_replaced_until_its_cast_stop_settles(self):
        parameters = {"context": self.context, "generation": "original"}
        os.kill(self.browser_process, signal.SIGSTOP)
        try:
            command = self.command("context.trace.filmstrip.start", parameters, timeout=100)
            self.send(command)
            reply = self.receive()
            self.assertEqual(reply["requestId"], command["requestId"])
            self.assertEqual(reply["kind"], "error", reply)
            self.assertEqual(reply["error"]["code"], "TimeoutError")
            replacement = self.command("context.trace.filmstrip.start", {**parameters, "generation": "next"}, timeout=1000)
            self.send(replacement)
            reply = self.receive()
            self.assertEqual(reply["requestId"], replacement["requestId"])
            self.assertEqual(reply["error"]["code"], "InvalidArgumentError")
            self.assertIsNone(self.driver.poll())
        finally:
            os.kill(self.browser_process, signal.SIGCONT)
        self.request("context.trace.filmstrip.dispose", parameters)
        self.assertEqual(self.request("page.evaluate", self.evaluation("42")), {"kind": "number", "value": 42})
        successor = {**parameters, "generation": "successor"}
        self.request("context.trace.filmstrip.start", successor)
        self.request("context.trace.filmstrip.seal", successor)
        self.request("context.trace.filmstrip.dispose", successor)
