"""Real Chromium payloads cross small control frames without loss, replay or stream teardown."""

import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import struct
import threading

from test_driver_protocol import OwnedDriverCase


class BinaryBodyCase(OwnedDriverCase):
    resource_limits = {"controlFrameBytes": 32768, "pendingAttachments": 1}

    def setUp(self):
        super().setUp()
        self.requests = []
        self.payloads = {
            "/binary": ("application/octet-stream", bytes(range(256)) * 4096),
            "/text": ("text/plain; charset=utf-8", ("\u00e9\U0001f600\x00payload" * 16000).encode()),
            "/empty": ("text/plain", b""),
        }
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                owner.requests.append(self.path)
                content_type, payload = owner.payloads[self.path]
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_arguments):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def fetch(self, path):
        url = f"http://127.0.0.1:{self.server.server_port}{path}"
        self.request("page.evaluate", self.evaluation(f"fetch({json.dumps(url)}).then(response => response.arrayBuffer()).then(() => undefined)"))
        def matching_response():
            return next((event["parameters"] for event in self.events if event["event"] == "response" and event["parameters"]["url"] == url), None)
        # Browser events and the evaluation reply are independent public deliveries.
        while (response := matching_response()) is None:
            message = self.receive_frame(skip_events=False)
            self.assertEqual(message["kind"], "event", message)
        return self.command("response.body", {"page": self.page, "request": response["identifier"]})

    def receive_frame(self, skip_events=True):
        length, = struct.unpack("<I", self.read_exact(4))
        self.assertLessEqual(length, self.limits["controlFrameBytes"])
        frame = self.read_exact(length)
        if frame[0] == 0:
            identifier, offset = struct.unpack("<QI", frame[1:13])
            return {"kind": "chunk", "requestId": identifier, "offset": offset, "bytes": frame[13:]}
        message = json.loads(frame)
        if message["kind"] == "event":
            self.events.append(message)
            if skip_events:
                return self.receive_frame()
        return message

    def receive_attachment(self, command, cancel=False, encoding=None):
        self.send(command)
        start = self.receive_frame()
        self.assertEqual(start["requestId"], command["requestId"])
        self.assertEqual(start["kind"], "binaryStart", start)
        if encoding is not None:
            self.assertEqual(start["encoding"], encoding, start)
        if cancel:
            self.send({"kind": "cancel", "requestId": command["requestId"]})
        encoded = bytearray()
        chunks = 0
        while True:
            message = self.receive_frame()
            self.assertEqual(message["requestId"], command["requestId"])
            if message["kind"] != "chunk":
                break
            self.assertEqual(message["offset"], len(encoded))
            encoded.extend(message["bytes"])
            chunks += 1
        if cancel:
            self.assertEqual(message["kind"], "error", message)
            self.assertEqual(message["error"]["code"], "CancelledError", message)
            self.assertLess(len(encoded), start["encodedLength"])
            return None
        self.assertEqual(message["kind"], "binaryResult", message)
        self.assertEqual(len(encoded), start["encodedLength"])
        self.assertEqual(message["byteLength"], start["byteLength"])
        decoded = base64.b64decode(encoded, validate=True) if start["encoding"] == "base64" else encoded
        self.assertEqual(len(decoded), start["byteLength"])
        if len(encoded) > self.limits["controlFrameBytes"]:
            self.assertGreater(chunks, 1)
        return decoded


class BodyTransferTests(BinaryBodyCase):
    def test_oversized_cdp_event_retains_its_resource_failure_during_browser_cleanup(self):
        command = self.command("page.evaluate", self.evaluation("console.log('x'.repeat(9 * 1024 * 1024)); 42"))
        self.send(command)
        error = self.receive()
        self.assertEqual(error["requestId"], command["requestId"])
        self.assertEqual(error["kind"], "error", error)
        self.assertEqual(error["error"]["code"], "ResourceLimitError", error)
        self.assertIn("CDP event", error["error"]["message"])
        self.assert_resources_released()

    def test_binary_body_exceeds_the_ordinary_cdp_reply_limit(self):
        payload = bytes(range(256)) * (9 * 4096)
        self.payloads["/large-binary"] = ("application/octet-stream", payload)
        self.assertEqual(self.receive_attachment(self.fetch("/large-binary")), payload)
        self.assertEqual(self.requests, ["/large-binary"])
        self.assertEqual(self.request("page.evaluate", self.evaluation("42")), {"kind": "number", "value": 42})

    def test_json_escaped_body_exceeds_the_ordinary_cdp_reply_limit(self):
        payload = b"\x00" * (2 * 1024 * 1024)
        self.payloads["/escaped-text"] = ("text/plain; charset=utf-8", payload)
        self.assertEqual(self.receive_attachment(self.fetch("/escaped-text"), encoding="raw"), payload)
        self.assertEqual(self.requests, ["/escaped-text"])

    def test_binary_bytes_cross_control_limits_without_replaying_the_request(self):
        command = self.fetch("/binary")
        self.assertEqual(self.receive_attachment(command), self.payloads["/binary"][1])
        self.assertEqual(self.requests, ["/binary"])
        self.assertEqual(self.request("page.evaluate", self.evaluation("42")), {"kind": "number", "value": 42})

    def test_text_utf8_and_nul_survive_raw_chunks(self):
        command = self.fetch("/text")
        self.assertEqual(self.receive_attachment(command), self.payloads["/text"][1])

    def test_empty_body_has_complete_start_and_terminal_without_data_frames(self):
        self.assertEqual(self.receive_attachment(self.fetch("/empty")), b"")

    def test_cancelled_partial_transfer_releases_its_slot_and_keeps_the_page_usable(self):
        command = self.fetch("/binary")
        self.receive_attachment(command, cancel=True)
        successor = self.command("response.body", command["parameters"])
        self.assertEqual(self.receive_attachment(successor), self.payloads["/binary"][1])
        self.assertEqual(self.requests, ["/binary"])
        self.assertEqual(self.request("page.evaluate", self.evaluation("42")), {"kind": "number", "value": 42})


class BodyLimitTests(BinaryBodyCase):
    resource_limits = {"controlFrameBytes": 32768, "binaryAttachmentBytes": 1024, "pendingAttachments": 1}

    def test_oversized_body_rejects_only_its_call_and_releases_its_slot(self):
        self.payloads["/large-binary"] = ("application/octet-stream", bytes(range(256)) * (9 * 4096))
        self.send(self.fetch("/large-binary"))
        error = self.receive()
        self.assertEqual(error["kind"], "error", error)
        self.assertEqual(error["error"]["code"], "ResourceLimitError", error)
        self.assertEqual(self.receive_attachment(self.fetch("/empty")), b"")
        self.assertEqual(self.request("page.evaluate", self.evaluation("42")), {"kind": "number", "value": 42})


class ScreenshotCase(BinaryBodyCase):
    def prepare_pixels(self):
        self.request("page.evaluate", self.evaluation("""(() => {
            document.body.style.margin = '0';
            const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
            const context = canvas.getContext('2d'); const pixels = context.createImageData(640, 480);
            let value = 123456789;
            for (let index = 0; index < pixels.data.length; index += 4) {
                value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
                pixels.data[index] = value & 255; pixels.data[index+1] = (value >>> 8) & 255;
                pixels.data[index+2] = (value >>> 16) & 255; pixels.data[index+3] = 255;
            }
            context.putImageData(pixels, 0, 0); document.body.append(canvas);
        })()"""))



class ScreenshotTransferTests(ScreenshotCase):
    def test_screenshot_binary_frames_are_complete_and_keep_the_page_usable(self):
        self.prepare_pixels()
        image = self.receive_attachment(self.command("page.screenshot", {"page": self.page}), encoding="base64")
        self.assertEqual(image[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(struct.unpack(">II", image[16:24]), (1280, 720))
        self.assertGreater(len(image), self.limits["controlFrameBytes"])
        self.assertEqual(self.request("page.evaluate", self.evaluation("42")), {"kind": "number", "value": 42})

    def test_cancelled_screenshot_stream_releases_its_slot_for_a_successor(self):
        self.prepare_pixels()
        self.receive_attachment(self.command("page.screenshot", {"page": self.page}), cancel=True)
        image = self.receive_attachment(self.command("page.screenshot", {"page": self.page, "clip": {"x": 0, "y": 0, "width": 1, "height": 1}}))
        self.assertEqual(struct.unpack(">II", image[16:24]), (1, 1))


class ScreenshotLimitTests(ScreenshotCase):
    resource_limits = {"controlFrameBytes": 32768, "binaryAttachmentBytes": 1024, "pendingAttachments": 1}

    def test_screenshot_payload_limit_rejects_only_its_call(self):
        self.prepare_pixels()
        self.send(self.command("page.screenshot", {"page": self.page}))
        error = self.receive()
        self.assertEqual(error["kind"], "error", error)
        self.assertEqual(error["error"]["code"], "ResourceLimitError", error)
        image = self.receive_attachment(self.command("page.screenshot", {"page": self.page, "clip": {"x": 0, "y": 0, "width": 1, "height": 1}}))
        self.assertEqual(struct.unpack(">II", image[16:24]), (1, 1))
