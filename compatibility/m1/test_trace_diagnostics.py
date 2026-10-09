"""Trace diagnostics must not consume console handles or the shared event outbox."""

import json

from test_driver_protocol import OwnedDriverCase


class TraceDiagnosticTests(OwnedDriverCase):
    def control(self, method, generation="trace"):
        return self.request(f"context.trace.{method}", {"context": self.context, "generation": generation})

    def test_trace_only_console_objects_leave_all_public_handle_slots_available(self):
        self.control("start")
        self.request("page.evaluate", self.evaluation("(() => { for (let index = 0; index < 1000; index++) console.log({index}); return 42; })()"))
        diagnostics = self.control("pull")["events"]
        self.assertEqual(len(diagnostics), 1000)
        self.assertEqual(json.loads(diagnostics[-1]["raw"])["args"][0]["preview"]["properties"][0]["value"], "999")
        self.assertFalse(any(event["event"] == "console" for event in self.events))
        parent = self.request("page.evaluateHandle", self.evaluation("Object.fromEntries(Array.from({length: 4095}, (_, index) => [index, {index}]))"))
        properties = self.request("handle.getProperties", {"page": self.page, "handle": parent["handles"][0]["identifier"]})
        self.assertEqual(len(properties["handles"]), 4095)
        self.control("stop")

    def test_start_and_stop_follow_driver_acceptance_order(self):
        start = self.command("context.trace.start", {"context": self.context, "generation": "trace"})
        evaluation = self.command("page.evaluate", self.evaluation("console.log('captured after start')"))
        self.send(start)
        self.send(evaluation)
        replies = [self.receive(), self.receive()]
        self.assertEqual({reply["requestId"] for reply in replies}, {start["requestId"], evaluation["requestId"]})
        self.assertTrue(all(reply["kind"] == "result" for reply in replies), replies)
        diagnostics = self.control("stop")["events"]
        self.assertEqual(len(diagnostics), 1)
        self.assertEqual(json.loads(diagnostics[0]["raw"])["args"][0]["value"], "captured after start")
        self.request("page.evaluate", self.evaluation("console.log('outside recording')"))
        self.control("start", "next")
        self.assertEqual(self.control("stop", "next")["events"], [])


class TraceDiagnosticFrameLimitTests(OwnedDriverCase):
    resource_limits = {"controlFrameBytes": 32768}

    def test_recording_overflow_keeps_the_driver_and_page_usable(self):
        parameters = {"context": self.context, "generation": "trace"}
        self.request("context.trace.start", parameters)
        result = self.request("page.evaluate", self.evaluation("(() => { console.log('x'.repeat(20000)); return 42; })()"))
        self.assertEqual(result, {"kind": "number", "value": 42})
        self.send(self.command("context.trace.stop", parameters))
        reply = self.receive()
        self.assertEqual(reply["kind"], "error", reply)
        self.assertEqual(reply["error"]["code"], "ResourceLimitError")
        self.assertIsNotNone(reply["requestId"])
        self.assertEqual(self.request("page.evaluate", self.evaluation("43")), {"kind": "number", "value": 43})
        self.request("context.trace.start", parameters)
        self.assertEqual(self.request("context.trace.stop", parameters)["events"], [])
