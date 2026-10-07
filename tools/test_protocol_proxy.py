"""The attribution proxy must preserve fragmented wire bytes and never retain payloads."""

import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

specification = importlib.util.spec_from_file_location("protocol_proxy", Path("benchmarks/protocol-proxy.py"))
proxy = importlib.util.module_from_spec(specification)
specification.loader.exec_module(proxy)


class ProtocolProxyTests(unittest.TestCase):
    def test_fragmented_frames_and_partial_writes_preserve_exact_bytes_without_payloads(self):
        messages = [
            {"id": 1, "method": "Runtime.evaluate", "params": {"expression": "private-value\U0001f600\ud800"}},
            {"id": 2, "method": "Input.insertText", "params": {"text": "private-value"}},
        ]
        wire = b"\0".join(json.dumps(message).encode() for message in messages) + b"\0"
        received = bytearray()
        output = io.StringIO()

        def write(_descriptor, chunk):
            accepted = min(3, len(chunk))
            received.extend(chunk[:accepted])
            return accepted

        with patch.object(proxy.os, "read", side_effect=[wire[:1], wire[1:19], wire[19:61], wire[61:], b""]), patch.object(proxy.os, "write", side_effect=write):
            proxy.forward(3, 4, "send", proxy.Recorder(output))
        self.assertEqual(received, wire)
        records = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([record["id"] for record in records], [1, 2])
        self.assertEqual(sum(record["bytes"] for record in records), len(wire))
        self.assertEqual(records[0]["scriptUtf16Units"], len(messages[0]["params"]["expression"].encode("utf-16-le", errors="surrogatepass")) // 2)
        self.assertNotIn("private-value", output.getvalue())
        self.assertNotIn("params", output.getvalue())

    def test_truncated_frame_is_reported_and_not_counted_as_a_complete_message(self):
        output = io.StringIO()
        with patch.object(proxy.os, "read", side_effect=[b'{"id":1}', b""]), patch.object(proxy.os, "write", side_effect=lambda _descriptor, chunk: len(chunk)):
            with self.assertRaisesRegex(ValueError, "inside a protocol message"):
                proxy.forward(3, 4, "receive", proxy.Recorder(output))
        self.assertEqual(output.getvalue(), "")

    def test_response_payloads_are_not_retained(self):
        output = io.StringIO()
        proxy.Recorder(output).message("receive", 1, b'{"id":7,"sessionId":"session","result":{"value":"private-value"}}')
        record = json.loads(output.getvalue())
        self.assertEqual(record["id"], 7)
        self.assertEqual(record["error"], False)
        self.assertNotIn("private-value", output.getvalue())


if __name__ == "__main__":
    unittest.main()
