"""Native console subscriptions, independent references and bounded failure cleanup."""

import json
import struct

from test_driver_protocol import OwnedDriverCase


class ConsoleLifetimeTests(OwnedDriverCase):
    def console_events(self):
        return [event["parameters"] for event in self.events if event["event"] == "console"]

    def synchronize(self):
        self.request("page.evaluate", self.evaluation("42"))

    def test_subscription_applies_before_the_next_accepted_evaluation(self):
        self.synchronize()
        for enabled in [True, False, True]:
            before = len(self.console_events())
            control = self.command("page.console.subscribe", {"page": self.page, "enabled": enabled})
            evaluation = self.command("page.evaluate", self.evaluation("console.log('ordered')"))
            self.send(control)
            self.send(evaluation)
            replies = [self.receive(), self.receive()]
            self.assertEqual({reply["requestId"] for reply in replies}, {control["requestId"], evaluation["requestId"]})
            self.assertTrue(all(reply["kind"] == "result" for reply in replies), replies)
            self.synchronize()
            self.assertEqual(len(self.console_events()) - before, int(enabled))

    def test_discarding_a_message_does_not_release_other_console_references(self):
        self.request("page.console.subscribe", {"page": self.page, "enabled": True})
        self.request("page.evaluate", self.evaluation("globalThis.sharedConsoleObject = {answer: 42}; console.log(sharedConsoleObject, sharedConsoleObject); console.log(sharedConsoleObject)"))
        self.synchronize()
        first, second = self.console_events()
        self.request("handle.discard", {"page": self.page, "group": first["group"]})
        parameter = {"page": self.page, "handle": second["handles"][0]["identifier"]}
        self.assertEqual(self.request("handle.jsonValue", parameter)["entries"], [[[97, 110, 115, 119, 101, 114], {"kind": "number", "value": 42}]])
        self.request("handle.dispose", parameter)
        self.request("handle.dispose", parameter)

    def test_unobserved_logs_do_not_consume_handle_slots_or_timeout_application_work(self):
        # Release replies wait behind this application task for longer than allocation
        # rollback's 500ms budget. Unobserved console cleanup must not reuse that budget.
        self.request("page.evaluate", self.evaluation("(() => { for (let index = 0; index < 1000; index++) console.log({index}); const end = performance.now() + 900; while (performance.now() < end) {} return 42; })()"))
        self.synchronize()
        self.assertEqual(self.console_events(), [])
        parent = self.request("page.evaluateHandle", self.evaluation("Object.fromEntries(Array.from({length: 4095}, (_, index) => [index, {index}]))"))
        properties = self.request("handle.getProperties", {"page": self.page, "handle": parent["handles"][0]["identifier"]})
        self.assertEqual(len(properties["handles"]), 4095)

    def test_console_exhaustion_reports_originating_resource_error_and_releases_browser(self):
        parent = self.request("page.evaluateHandle", self.evaluation("Object.fromEntries(Array.from({length: 4095}, (_, index) => [index, {index}]))"))
        self.request("handle.getProperties", {"page": self.page, "handle": parent["handles"][0]["identifier"]})
        self.request("page.console.subscribe", {"page": self.page, "enabled": True})
        self.send(self.command("page.evaluate", self.evaluation("console.log({overflow: true})")))
        reply = self.receive()
        if reply["kind"] == "result":
            reply = self.receive()
        self.assertEqual(reply["kind"], "error", reply)
        self.assertIsNone(reply["requestId"])
        self.assertEqual(reply["error"]["code"], "ResourceLimitError")
        self.assertEqual(reply["error"]["method"], "console")
        self.assertIn("4096", reply["error"]["message"])
        self.driver.wait(timeout=8)
        self.assert_resources_released()

    def test_in_transit_discard_does_not_interrupt_a_later_application_task(self):
        self.request("page.console.subscribe", {"page": self.page, "enabled": True})
        self.request("page.evaluate", self.evaluation("console.log({answer: 42})"))
        self.synchronize()
        event, = self.console_events()
        # Chromium emits a marker before entering the long synchronous task. Receiving
        # that marker ensures disposal is requested while its release reply is delayed.
        evaluation = self.command("page.evaluate", self.evaluation("(() => { console.log('busy'); const end = performance.now() + 1200; while (performance.now() < end) {} return 42; })()"))
        self.send(evaluation)
        while True:
            length, = struct.unpack("<I", self.read_exact(4))
            message = json.loads(self.read_exact(length))
            self.assertEqual(message["kind"], "event", message)
            if message["event"] == "console":
                break
        discard = self.command("handle.discard", {"page": self.page, "group": event["group"]})
        self.send(discard)
        replies = {reply["requestId"]: reply for reply in [self.receive(), self.receive()]}
        self.assertEqual(replies[discard["requestId"]]["kind"], "result", replies)
        self.assertEqual(replies[evaluation["requestId"]]["value"], {"kind": "number", "value": 42}, replies)
        self.synchronize()

    def test_cleared_console_arguments_are_already_disposed_without_retiring_page(self):
        self.request("page.console.subscribe", {"page": self.page, "enabled": True})
        self.request("page.evaluate", self.evaluation("console.log({answer: 42})"))
        event, = self.console_events()
        self.request("page.evaluate", self.evaluation("console.clear()"))
        self.request("handle.dispose", {"page": self.page, "handle": event["handles"][0]["identifier"]})
        self.assertEqual(self.request("page.evaluate", self.evaluation("42")), {"kind": "number", "value": 42})

    def test_context_subscription_captures_future_pages_and_page_disable_cannot_override_it(self):
        self.request("context.console.subscribe", {"context": self.context, "enabled": True})
        self.page = self.request("context.newPage", {"context": self.context})["identifier"]
        self.request("page.console.subscribe", {"page": self.page, "enabled": False})
        self.request("page.evaluate", self.evaluation("console.log('context subscription')"))
        self.synchronize()
        event, = self.console_events()
        self.assertEqual(json.loads(event["consoleJson"])["args"][0]["value"], "context subscription")
        self.request("context.console.subscribe", {"context": self.context, "enabled": False})
        self.request("page.evaluate", self.evaluation("console.log('disabled')"))
        self.synchronize()
        self.assertEqual(len(self.console_events()), 1)


class ConsolePublicationTests(OwnedDriverCase):
    resource_limits = {"controlFrameBytes": 32768}

    def test_unpublishable_console_event_fails_explicitly_and_releases_owned_resources(self):
        self.request("page.console.subscribe", {"page": self.page, "enabled": True})
        self.send(self.command("page.evaluate", self.evaluation("console.log('x'.repeat(12000), {argument: true})")))
        # This receiver avoids the base class's event recursion for a large event burst.
        while True:
            length, = struct.unpack("<I", self.read_exact(4))
            self.assertLessEqual(length, self.limits["controlFrameBytes"])
            reply = json.loads(self.read_exact(length))
            if reply["kind"] == "error":
                break
        self.assertIsNone(reply["requestId"])
        self.assertEqual(reply["error"]["code"], "ResourceLimitError")
        self.assertEqual(reply["error"]["method"], "protocol.output")
        self.driver.wait(timeout=8)
        self.assert_resources_released()
