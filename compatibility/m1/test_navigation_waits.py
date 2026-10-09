"""Native waiter acceptance, cancellation and page ownership boundaries."""

from test_driver_protocol import OwnedDriverCase


class NavigationWaitLifecycleTests(OwnedDriverCase):
    def navigate_and_cursor(self):
        result = self.request("page.goto", {"page": self.page, "url": "about:blank"})
        sequence = next(frame["navigationSequence"] for frame in result["frames"] if frame["identifier"] == self.frame)
        return {"page": self.page, "frame": self.frame, "sequence": sequence}

    def test_capture_is_accepted_before_a_later_page_close_even_if_its_task_runs_late(self):
        cursor = self.navigate_and_cursor()
        capture = self.command("page.navigation.capture", {"page": self.page, "sequence": cursor["sequence"]})
        close = self.command("page.close", {"page": self.page})
        self.send(capture)
        self.send(close)
        replies = {reply["requestId"]: reply for reply in [self.receive(), self.receive()]}
        self.assertEqual(replies[capture["requestId"]]["kind"], "result")
        self.assertEqual(replies[capture["requestId"]]["value"]["sequence"], cursor["sequence"])
        self.assertEqual(replies[close["requestId"]]["kind"], "result")

    def test_host_cursor_includes_a_navigation_that_precedes_native_registration(self):
        cursor = self.navigate_and_cursor()
        self.request("page.evaluate", self.evaluation("location.hash = 'in-flight'; undefined"))
        accepted = self.request("page.navigation.capture", {"page": self.page, "sequence": cursor["sequence"]})
        self.assertEqual(accepted["sequence"], cursor["sequence"])
        event = self.request("page.navigation.next", cursor)
        self.assertTrue(event["url"].endswith("#in-flight"))
        result = self.request("page.navigation.complete", {"page": self.page, "frame": self.frame, "sequence": event["sequence"], "waitUntil": "commit"})
        self.assertIsNone(result["response"])

    def test_cancelled_wait_does_not_consume_navigation_or_affect_another_waiter(self):
        cursor = self.navigate_and_cursor()
        pending = self.command("page.navigation.next", cursor)
        self.send(pending)
        self.send({"kind": "cancel", "requestId": pending["requestId"]})
        reply = self.receive()
        self.assertEqual(reply["requestId"], pending["requestId"])
        self.assertEqual(reply["error"]["code"], "CancelledError")
        self.request("page.evaluate", self.evaluation("location.hash = 'survivor'; undefined"))
        event = self.request("page.navigation.next", cursor)
        self.assertTrue(event["url"].endswith("#survivor"))

    def test_page_close_releases_an_unbounded_wait_without_closing_sibling(self):
        cursor = self.navigate_and_cursor()
        sibling = self.request("context.newPage", {"context": self.context})["identifier"]
        pending = self.command("page.navigation.next", cursor)
        close = self.command("page.close", {"page": self.page})
        self.send(pending)
        self.send(close)
        replies = {reply["requestId"]: reply for reply in [self.receive(), self.receive()]}
        self.assertEqual(replies[pending["requestId"]]["error"]["code"], "TargetClosedError")
        self.assertEqual(replies[close["requestId"]]["kind"], "result")
        self.assertEqual(self.request("page.evaluate", {**self.evaluation("42"), "page": sibling}), {"kind": "number", "value": 42})
