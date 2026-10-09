"""Raw header waiters retain cancellation, page ownership and original HTTP identity."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import struct
import threading

from test_driver_protocol import OwnedDriverCase


class NetworkHeaderLifecycleTests(OwnedDriverCase):
    def setUp(self):
        super().setUp()
        self.arrived = threading.Event()
        self.release_response = threading.Event()
        self.requests = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                owner.requests.append(self.path)
                owner.arrived.set()
                if not owner.release_response.wait(10):
                    return
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/plain")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Set-Cookie", "first=one")
                    self.send_header("Set-Cookie", "second=two")
                    self.end_headers()
                    self.wfile.write(b"original")
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *_arguments):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)

    def close_server(self):
        self.release_response.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def start_held_request(self):
        url = f"http://127.0.0.1:{self.server.server_port}/held"
        source = f"globalThis.headerFetch = fetch({json.dumps(url)}).then(response => response.text()).catch(() => 'closed'); undefined"
        self.request("page.evaluate", self.evaluation(source))
        self.assertTrue(self.arrived.wait(5), "original HTTP request did not reach the server")
        while True:
            for event in self.events:
                if event["event"] == "request" and event["parameters"]["url"] == url:
                    return event["parameters"]
            length, = struct.unpack("<I", self.read_exact(4))
            message = json.loads(self.read_exact(length))
            self.assertEqual(message["kind"], "event", message)
            self.events.append(message)

    def header_parameters(self, request, kind="request"):
        return {"page": self.page, "requestIdentity": request["identity"], "kind": kind}

    def test_cancelled_and_expired_header_waiters_do_not_consume_the_original_headers(self):
        request = self.start_held_request()
        expired = self.command("network.headers", self.header_parameters(request), timeout=50)
        self.send(expired)
        reply = self.receive()
        self.assertEqual(reply["requestId"], expired["requestId"])
        self.assertEqual(reply["error"]["code"], "TimeoutError", reply)
        cancelled = self.command("network.headers", self.header_parameters(request))
        self.send(cancelled)
        self.send({"kind": "cancel", "requestId": cancelled["requestId"]})
        reply = self.receive()
        self.assertEqual(reply["requestId"], cancelled["requestId"])
        self.assertEqual(reply["error"]["code"], "CancelledError", reply)
        self.assertEqual(self.request("page.evaluate", self.evaluation("42")), {"kind": "number", "value": 42})
        self.release_response.set()
        self.assertEqual(self.request("page.evaluate", self.evaluation("headerFetch")), {"kind": "string", "units": list(b"original")})
        headers = self.request("network.headers", self.header_parameters(request))
        self.assertTrue(any(header["name"].lower() == "host" for header in headers))
        response_headers = self.request("network.headers", self.header_parameters(request, "response"))
        cookies = [header["value"] for header in response_headers if header["name"].lower() == "set-cookie"]
        self.assertEqual(cookies, ["first=one", "second=two"])
        self.assertEqual(self.requests, ["/held"])
        invalid = self.command("network.headers", {**self.header_parameters(request), "requestIdentity": "unrelated-owner"})
        self.send(invalid)
        self.assertEqual(self.receive()["error"]["code"], "ResourceLimitError")

    def test_page_close_ends_its_original_header_waiter(self):
        request = self.start_held_request()
        pending = self.command("network.headers", self.header_parameters(request))
        closing = self.command("page.close", {"page": self.page})
        self.send(pending)
        self.send(closing)
        replies = [self.receive(), self.receive()]
        by_identifier = {reply["requestId"]: reply for reply in replies}
        self.assertEqual(by_identifier[pending["requestId"]]["error"]["code"], "TargetClosedError")
        self.assertEqual(by_identifier[closing["requestId"]]["kind"], "result")
        self.assertEqual(self.requests, ["/held"])
