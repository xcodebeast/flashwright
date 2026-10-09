"""Native cancellation at history query and reload dispatch ownership boundaries."""

import os
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from test_driver_protocol import OwnedDriverCase


class HistoryNavigationLifecycleTests(OwnedDriverCase):
    def test_cancelled_history_query_does_not_dispatch_a_late_traversal(self):
        for method in ["page.goBack", "page.goForward"]:
            with self.subTest(method=method):
                self.request("page.goto", {"page": self.page, "url": "data:text/html,first"})
                self.request("page.goto", {"page": self.page, "url": "data:text/html,second"})
                if method == "page.goForward":
                    self.request("page.goBack", {"page": self.page})
                expected = "data:text/html,first" if method == "page.goForward" else "data:text/html,second"
                os.kill(self.browser_process, signal.SIGSTOP)
                try:
                    pending = self.command(method, {"page": self.page})
                    self.send(pending)
                    time.sleep(0.05)
                    self.send({"kind": "cancel", "requestId": pending["requestId"]})
                    reply = self.receive()
                    self.assertEqual(reply["requestId"], pending["requestId"])
                    self.assertEqual(reply["error"]["code"], "CancelledError", reply)
                finally:
                    os.kill(self.browser_process, signal.SIGCONT)
                self.assertEqual(self.request("page.evaluate", self.evaluation("location.href")), {"kind": "string", "units": [ord(character) for character in expected]})

    def test_cancelling_dispatched_reload_does_not_replay_and_preserves_sibling(self):
        received = threading.Event()
        committed = threading.Event()
        release = threading.Event()
        document_requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/committed":
                    committed.set()
                    self.send_response(200)
                    self.end_headers()
                    return
                if self.path == "/favicon.ico":
                    self.send_response(204)
                    self.end_headers()
                    return
                document_requests.append(self.path)
                if len(document_requests) == 2:
                    received.set()
                    release.wait(10)
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                try:
                    self.wfile.write(b"<!doctype html><title>history</title><script>fetch('/committed')</script>")
                except (BrokenPipeError, ConnectionResetError):
                    pass
            def log_message(self, *arguments):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            self.request("page.goto", {"page": self.page, "url": f"http://127.0.0.1:{server.server_port}/history"})
            self.assertTrue(committed.wait(5))
            committed.clear()
            pending = self.command("page.reload", {"page": self.page})
            self.send(pending)
            self.assertTrue(received.wait(5), "reload must reach server before cancellation")
            self.send({"kind": "cancel", "requestId": pending["requestId"]})
            reply = self.receive()
            self.assertEqual(reply["requestId"], pending["requestId"])
            self.assertEqual(reply["error"]["code"], "CancelledError", reply)
            sibling = self.request("context.newPage", {"context": self.context})["identifier"]
            self.assertEqual(self.request("page.evaluate", {**self.evaluation("42"), "page": sibling}), {"kind": "number", "value": 42})
            release.set()
            self.assertTrue(committed.wait(5), "released reload must commit before inspection")
            self.request("page.waitForLoadState", {"page": self.page, "state": "load"})
            self.assertEqual(document_requests, ["/history", "/history"])
            self.assertEqual(self.request("page.reload", {"page": self.page})["response"]["status"], 200)
            self.assertEqual(document_requests, ["/history"] * 3)
        finally:
            release.set()
            server.shutdown()
            server.server_close()
            thread.join(2)

    def test_invalid_history_options_fail_at_native_boundary_without_moving_history(self):
        for method in ["page.reload", "page.goBack", "page.goForward"]:
            for options in [{"waitUntil": "invalid"}, {"referer": "https://example.test"}]:
                self.send(self.command(method, {"page": self.page, **options}))
                reply = self.receive()
                self.assertIn(reply["error"]["code"], ["InvalidArgumentError", "UnsupportedFeatureError"])
        self.assertEqual(self.request("page.evaluate", self.evaluation("location.href")), {"kind": "string", "units": [ord(character) for character in "about:blank"]})
