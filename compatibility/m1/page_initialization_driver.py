"""An unpublished native page must settle even if its setup reply never arrives."""

import json
import os
from pathlib import Path
import select
import time
import unittest

from test_driver_protocol import OwnedDriverCase


class PageInitializationTests(OwnedDriverCase):
    create_initial_page = False

    def setUp(self):
        super().setUp()
        settings = {
            "Security.setIgnoreCertificateErrors": {"ignoreHTTPSErrors": True},
            "Emulation.setScriptExecutionDisabled": {"javaScriptEnabled": False},
            "Emulation.setTouchEmulationEnabled": {"hasTouch": True},
            "Emulation.setUserAgentOverride": {"userAgent": "Flashwright initialization fixture"},
        }.get(os.environ["FLASHWRIGHT_INITIALIZATION_METHOD"])
        if settings:
            self.request("context.close", {"context": self.context})
            self.context = self.request("browser.newContext", {"browser": self.browser, **settings})["identifier"]
        self.events.clear()

    def records(self):
        records = []
        for path in Path(os.environ["FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY"]).glob("*.jsonl"):
            # A concurrent writer may not have completed the last line yet.
            records.extend(json.loads(line) for line in path.read_text().split("\n")[:-1])
        return records

    def test_original_root_detachment_settles_creation_without_setup_reply(self):
        # Native null means no deadline; public timeout: 0 is translated by the client.
        command = self.command("context.newPage", {"context": self.context}, timeout=None)
        self.send(command)
        deadline = time.monotonic() + 5
        while not any(record["kind"] == "originalRootDetached" for record in self.records()):
            self.assertLess(time.monotonic(), deadline, "Chromium must report actual root detachment")
            time.sleep(0.02)
        records = self.records()
        self.assertEqual(sum(record["kind"] == "nativeDetachRequested" for record in records), 1)
        self.assertTrue(next(record for record in records if record["kind"] == "originalRootDetached")["replyStillHeld"])
        ready, _, _ = select.select([self.driver.stdout], [], [], 2)
        self.assertTrue(ready, "Unbounded creation remained pending after original root detachment")
        reply = self.receive()
        self.assertEqual(reply["requestId"], command["requestId"])
        self.assertEqual(reply["kind"], "error", reply)
        self.assertEqual(reply["error"]["code"], "TargetClosedError", reply)
        self.assertFalse(any(event["event"] in ["page", "close"] for event in self.events), "An unpublished page must not emit public lifecycle events")
        self.page = self.request("context.newPage", {"context": self.context})["identifier"]
        self.assertEqual(self.request("page.evaluate", self.evaluation("42")), {"kind": "number", "value": 42})
        self.request("context.close", {"context": self.context})
        self.request("browser.close", {"browser": self.browser})
        self.assert_resources_released()


if __name__ == "__main__":
    unittest.main(verbosity=2)
