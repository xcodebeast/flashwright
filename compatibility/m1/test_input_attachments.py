"""Inbound payload staging cannot execute browser commands early or strand request ownership."""

import os
import struct

from test_driver_protocol import OwnedDriverCase


class InputAttachmentTests(OwnedDriverCase):
    resource_limits = {"binaryAttachmentBytes": 1024, "pendingAttachments": 1}

    def begin(self, length, timeout=None):
        message = self.command("page.evaluate", self.evaluation("globalThis.unwantedInput = true"), timeout)
        message["inputByteLength"] = length
        self.send(message)
        return message["requestId"]

    def chunk(self, identifier, offset, payload):
        body = b"\0" + struct.pack("<QI", identifier, offset) + payload
        frame = struct.pack("<I", len(body)) + body
        while frame:
            frame = frame[os.write(self.driver.stdin.fileno(), frame):]

    def finish(self, identifier, aborted=False):
        self.send({"kind": "inputEnd", "requestId": identifier, "aborted": aborted})

    def assert_page_unchanged(self):
        result = self.request("page.evaluate", self.evaluation("globalThis.unwantedInput === undefined"))
        self.assertEqual(result, {"kind": "boolean", "value": True})

    def test_partial_body_allows_sibling_requests_and_completion_cannot_run_an_unadmitted_method(self):
        identifier = self.begin(4)
        self.chunk(identifier, 0, bytes([0, 255]))
        self.assert_page_unchanged()
        self.chunk(identifier, 2, bytes([128, 13]))
        self.finish(identifier)
        reply = self.receive()
        self.assertEqual(reply["requestId"], identifier)
        self.assertEqual(reply["error"]["code"], "UnsupportedFeatureError")
        self.assert_page_unchanged()

    def test_deadline_releases_input_slot_while_late_chunks_still_belong_to_old_request(self):
        identifier = self.begin(4, timeout=80)
        self.chunk(identifier, 0, b"ab")
        reply = self.receive()
        self.assertEqual(reply["requestId"], identifier)
        self.assertEqual(reply["error"]["code"], "TimeoutError")
        successor = self.begin(1)
        self.chunk(identifier, 2, b"c")
        self.finish(identifier, aborted=True)
        self.chunk(successor, 0, b"z")
        self.finish(successor)
        reply = self.receive()
        self.assertEqual(reply["requestId"], successor)
        self.assertEqual(reply["error"]["code"], "UnsupportedFeatureError")
        self.assert_page_unchanged()

    def test_rejected_oversized_and_over_capacity_headers_own_queued_chunks(self):
        active = self.begin(1)
        rejected = self.begin(2)
        reply = self.receive()
        self.assertEqual(reply["requestId"], rejected)
        self.assertEqual(reply["error"]["code"], "ResourceLimitError")
        self.chunk(rejected, 0, b"xy")
        self.finish(rejected)
        self.send({"kind": "cancel", "requestId": active})
        self.finish(active, aborted=True)
        self.assertEqual(self.receive()["error"]["code"], "CancelledError")
        oversized = self.begin(1025)
        self.assertEqual(self.receive()["error"]["code"], "ResourceLimitError")
        self.chunk(oversized, 0, b"late")
        self.finish(oversized, aborted=True)
        self.assert_page_unchanged()

    def test_incomplete_terminal_invalidates_stream_and_releases_browser(self):
        identifier = self.begin(2)
        self.chunk(identifier, 0, b"x")
        self.finish(identifier)
        self.assertNotEqual(self.driver.wait(timeout=8), 0)
        self.assert_resources_released()

    def test_corrupt_offset_invalidates_stream_and_releases_browser(self):
        identifier = self.begin(2)
        self.chunk(identifier, 1, b"x")
        self.assertNotEqual(self.driver.wait(timeout=8), 0)
        self.assert_resources_released()
