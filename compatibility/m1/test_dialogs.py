"""Small negotiated totals must retain dialog recovery and original-owner cleanup."""

import json
import os
import signal
import struct

from test_driver_protocol import OwnedDriverCase


class DialogDriverCase(OwnedDriverCase):
    def wait_for_dialog(self):
        while True:
            length, = struct.unpack("<I", self.read_exact(4))
            self.assertLessEqual(length, self.limits["controlFrameBytes"])
            message = json.loads(self.read_exact(length))
            self.assertEqual(message["kind"], "event", message)
            self.events.append(message)
            if message["event"] == "dialog":
                self.assertEqual(message["target"], self.page)
                return message["parameters"]["dialog"]

    def open_dialog(self):
        self.request("page.dialog.subscribe", {"page": self.page, "enabled": True})
        evaluation = self.command("page.evaluate", self.evaluation("confirm('original modal')"))
        self.send(evaluation)
        return evaluation, self.wait_for_dialog()


class TwoSlotDialogTests(DialogDriverCase):
    resource_limits = {"pendingOperations": 2}

    def test_browser_disconnect_settles_the_modal_evaluation_and_releases_owned_processes(self):
        evaluation, dialog = self.open_dialog()
        os.kill(self.browser_process, signal.SIGKILL)
        reply = self.receive()
        self.assertEqual(reply["requestId"], evaluation["requestId"], reply)
        self.assertEqual(reply["error"]["code"], "BrowserDisconnectedError", reply)
        self.assert_resources_released()
        self.send(self.command("dialog.accept", {"page": self.page, "dialog": dialog}))
        self.assertEqual(self.receive()["error"]["code"], "TargetClosedError")

    def test_dialog_metadata_exhaustion_reports_original_limit_and_releases_browser(self):
        self.request("page.dialog.subscribe", {"page": self.page, "enabled": True})
        # Chromium truncates message to10240 units, but preserves defaultPrompt on the wire.
        self.send(self.command("page.evaluate", self.evaluation("prompt('bounded metadata', 'x'.repeat(1024 * 1024))")))
        reply = self.receive()
        self.assertEqual(reply["kind"], "error", reply)
        self.assertIsNone(reply["requestId"], reply)
        self.assertEqual(reply["error"]["code"], "ResourceLimitError", reply)
        self.assertEqual(reply["error"]["method"], "page.dialog", reply)
        self.driver.wait(timeout=8)
        self.assert_resources_released()

    def test_subscription_changes_acknowledge_while_original_modal_blocks_evaluation(self):
        evaluation, dialog = self.open_dialog()
        for enabled in [False, True, False]:
            for owner in ["page", "context"]:
                self.assertIsNone(self.request(f"{owner}.dialog.subscribe", {owner: getattr(self, owner), "enabled": enabled}))
        handling = self.command("dialog.accept", {"page": self.page, "dialog": dialog})
        self.send(handling)
        replies = {reply["requestId"]: reply for reply in [self.receive(), self.receive()]}
        self.assertEqual(replies[handling["requestId"]]["kind"], "result", replies)
        self.assertEqual(replies[evaluation["requestId"]]["value"], {"kind": "boolean", "value": True})
        self.assertEqual(self.request("page.evaluate", self.evaluation("confirm('unobserved successor')")), {"kind": "boolean", "value": False})
        self.assertEqual(len([event for event in self.events if event["event"] == "dialog"]), 1)

    def test_close_retires_original_modal_without_affecting_sibling(self):
        sibling = self.request("context.newPage", {"context": self.context})["identifier"]
        evaluation, dialog = self.open_dialog()
        closing = self.command("page.close", {"page": self.page})
        self.send(closing)
        replies = {reply["requestId"]: reply for reply in [self.receive(), self.receive()]}
        self.assertEqual(replies[closing["requestId"]]["kind"], "result", replies)
        self.assertEqual(replies[evaluation["requestId"]]["error"]["code"], "TargetClosedError", replies)
        self.send(self.command("dialog.accept", {"page": self.page, "dialog": dialog}))
        self.assertEqual(self.receive()["error"]["code"], "TargetClosedError")
        self.assertEqual(self.request("page.evaluate", {**self.evaluation("42"), "page": sibling}), {"kind": "number", "value": 42})

    def test_dialog_recovery_releases_the_saturated_ordinary_lane(self):
        evaluation, dialog = self.open_dialog()
        rejected = self.command("page.evaluate", self.evaluation("42"))
        self.send(rejected)
        reply = self.receive()
        self.assertEqual(reply["requestId"], rejected["requestId"])
        self.assertEqual(reply["error"]["code"], "ResourceLimitError")
        handling = self.command("dialog.dismiss", {"page": self.page, "dialog": dialog})
        self.send(handling)
        replies = {reply["requestId"]: reply for reply in [self.receive(), self.receive()]}
        self.assertEqual(replies[handling["requestId"]]["kind"], "result", replies)
        self.assertEqual(replies[evaluation["requestId"]]["value"], {"kind": "boolean", "value": False})
        self.assertEqual(self.request("page.evaluate", self.evaluation("42"))["value"], 42)

    def test_cancelled_handling_retires_owner_and_preserves_original_cancellation(self):
        evaluation, dialog = self.open_dialog()
        os.kill(self.browser_process, signal.SIGSTOP)
        try:
            handling = self.command("dialog.accept", {"page": self.page, "dialog": dialog})
            self.send(handling)
            # Driver acceptance is ordered. This reply proves handling claimed its slot
            # before cancellation, without relying on a short scheduler deadline.
            barrier = self.command("page.evaluate", self.evaluation("42"))
            self.send(barrier)
            rejected = self.receive()
            self.assertEqual(rejected["requestId"], barrier["requestId"])
            self.assertEqual(rejected["error"]["code"], "ResourceLimitError")
            self.send({"kind": "cancel", "requestId": handling["requestId"]})
            replies = {reply["requestId"]: reply for reply in [self.receive(), self.receive()]}
            self.assertEqual(replies[handling["requestId"]]["error"]["code"], "CancelledError", replies)
            self.assertIn("cleanup", replies[handling["requestId"]]["error"])
            self.assertEqual(replies[evaluation["requestId"]]["kind"], "error", replies)
        finally:
            try:
                os.kill(self.browser_process, signal.SIGCONT)
            except ProcessLookupError:
                pass


class OneSlotDialogTests(DialogDriverCase):
    resource_limits = {"pendingOperations": 1}

    def test_subscriptions_reject_before_effect_and_native_defaults_still_complete(self):
        for owner in ["page", "context"]:
            request = self.command(f"{owner}.dialog.subscribe", {owner: getattr(self, owner), "enabled": True})
            self.send(request)
            reply = self.receive()
            self.assertEqual(reply["requestId"], request["requestId"])
            self.assertEqual(reply["error"]["code"], "ResourceLimitError")
        self.assertEqual(self.request("page.evaluate", self.evaluation("confirm('unobserved')")), {"kind": "boolean", "value": False})
        self.assertEqual(self.request("page.evaluate", self.evaluation("42"))["value"], 42)
        self.assertFalse(any(event["event"] == "dialog" for event in self.events))
