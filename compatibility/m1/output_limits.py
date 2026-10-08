"""Negotiated output limits preserve the stream, effects and unreturned allocation ownership."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
import threading
import time

from test_driver_protocol import OwnedDriverCase
from test_lifecycle import snapshot


def expect_resource_error(case, method, parameters, delivery="notDispatched"):
    command = case.command(method, parameters)
    case.send(command)
    reply = case.receive()
    case.assertEqual(reply["requestId"], command["requestId"], reply)
    case.assertEqual(reply["kind"], "error", reply)
    case.assertEqual(reply["error"]["code"], "ResourceLimitError", reply)
    case.assertEqual(reply["error"]["inputDelivery"], delivery, reply)
    case.assertIsNone(case.driver.poll())
    return reply["error"]


class ByteLimitTests(OwnedDriverCase):
    resource_limits = {"controlFrameBytes": 32768}

    def test_oversized_evaluation_runs_once_and_successor_is_usable(self):
        expression = "(globalThis.resultEffects = (globalThis.resultEffects || 0) + 1, 'x'.repeat(12000))"
        expect_resource_error(self, "page.evaluate", self.evaluation(expression))
        self.assertEqual(self.request("page.evaluate", self.evaluation("resultEffects")), {"kind": "number", "value": 1})

    def test_oversized_exception_does_not_replay_user_code(self):
        expression = "(() => { globalThis.errorEffects = (globalThis.errorEffects || 0) + 1; throw new Error('\\ud800'.repeat(7000)); })()"
        expect_resource_error(self, "page.evaluate", self.evaluation(expression))
        self.assertEqual(self.request("page.evaluate", self.evaluation("errorEffects")), {"kind": "number", "value": 1})

    def test_acknowledged_selection_survives_an_oversized_result_without_replay(self):
        self.request("page.evaluate", self.evaluation("(() => { document.body.innerHTML = '<select></select>'; const select = document.querySelector('select'); select.add(new Option('choice', 'x'.repeat(12000))); select.selectedIndex = -1; globalThis.selectionEvents = 0; select.addEventListener('change', () => ++selectionEvents); })()"))
        request = json.dumps({"selector": "css=select", "action": "selectOption", "values": [{"index": 0}], "force": False})
        expect_resource_error(self, "locator.run", {"page": self.page, "frame": self.frame, "action": "selectOption", "request": [ord(character) for character in request]}, "acknowledged")
        state = self.request("page.evaluate", self.evaluation("[selectionEvents, document.querySelector('select').selectedIndex, document.querySelector('select').value.length]"))
        self.assertEqual([item["value"] for item in state["items"]], [1, 0, 12000])

    def test_oversized_method_diagnostics_cannot_close_the_connection(self):
        method = "m" * (self.limits["controlFrameBytes"] - 150)
        self.assertLessEqual(len(json.dumps(self.command(method, {})).encode()), self.limits["controlFrameBytes"])
        error = expect_resource_error(self, method, {})
        self.assertEqual(error["method"], "protocol.output")
        self.assertEqual(self.request("page.evaluate", self.evaluation("42")), {"kind": "number", "value": 42})

    def test_oversized_browser_event_reports_a_global_error_and_releases_resources(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", "4")
                self.send_header("X-Large", "x" * 40000)
                self.end_headers()
                self.wfile.write(b"done")

            def log_message(self, *_arguments):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            self.send(self.command("page.goto", {"page": self.page, "url": f"http://127.0.0.1:{server.server_port}/main", "waitUntil": "load"}))
            reply = self.receive()
            self.assertEqual(reply["kind"], "error", reply)
            self.assertIsNone(reply["requestId"], reply)
            self.assertEqual(reply["error"]["code"], "ResourceLimitError", reply)
            self.assertEqual(reply["error"]["inputDelivery"], "uncertain", reply)
            self.assertNotEqual(self.driver.wait(timeout=10), 0)
            self.assert_resources_released()
            self.assertEqual(requests.count("/main"), 1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_oversized_page_exception_preserves_utf16_until_the_event_limit(self):
        # The outstanding evaluation never settles. Its uncaught timer exception must
        # independently reach the output limit, even with non-scalar UTF-16 text.
        expression = "new Promise(() => { setTimeout(() => { throw new Error('\\ud800'.repeat(40000)); }, 0); })"
        self.send(self.command("page.evaluate", self.evaluation(expression)))
        reply = self.receive()
        self.assertEqual(reply["kind"], "error", reply)
        self.assertIsNone(reply["requestId"], reply)
        self.assertEqual(reply["error"]["code"], "ResourceLimitError", reply)
        self.assertEqual(reply["error"]["method"], "protocol.output", reply)
        self.assertEqual(reply["error"]["inputDelivery"], "uncertain", reply)
        self.assertNotEqual(self.driver.wait(timeout=10), 0)
        self.assert_resources_released()


class NodeLimitTests(OwnedDriverCase):
    resource_limits = {"controlFrameBytes": 32768, "valueNodes": 1000}

    def test_output_node_limit_rejects_without_replaying_or_closing_the_page(self):
        error = expect_resource_error(self, "page.evaluate", self.evaluation("(globalThis.nodeEffects = (globalThis.nodeEffects || 0) + 1, Array.from({ length: 800 }, (_, index) => index))"))
        self.assertIn("depth or node", error["message"])
        self.assertEqual(self.request("page.evaluate", self.evaluation("nodeEffects")), {"kind": "number", "value": 1})

    def test_error_diagnostics_obey_the_node_limit_even_when_their_bytes_fit(self):
        expression = "(() => { globalThis.diagnosticEffects = (globalThis.diagnosticEffects || 0) + 1; throw new Error('x'.repeat(1200)); })()"
        error = expect_resource_error(self, "page.evaluate", self.evaluation(expression))
        self.assertIn("depth or node", error["message"])
        self.assertEqual(self.request("page.evaluate", self.evaluation("diagnosticEffects")), {"kind": "number", "value": 1})


class DepthLimitTests(OwnedDriverCase):
    resource_limits = {"controlFrameBytes": 32768, "valueDepth": 4}

    def test_output_depth_limit_rejects_without_replaying_or_closing_the_page(self):
        error = expect_resource_error(self, "page.evaluate", self.evaluation("(globalThis.depthEffects = (globalThis.depthEffects || 0) + 1, [[[1]]])"))
        self.assertIn("depth or node", error["message"])
        self.assertEqual(self.request("page.evaluate", self.evaluation("depthEffects")), {"kind": "number", "value": 1})


class PageAllocationLimitTests(OwnedDriverCase):
    resource_limits = {"controlFrameBytes": 32768, "valueNodes": 8}
    create_initial_page = False

    def test_rejected_pages_are_disposed_privately_and_the_context_remains_usable(self):
        for _attempt in range(4):
            error = expect_resource_error(self, "context.newPage", {"context": self.context})
            self.assertEqual(error["cleanup"], "resourceDisposed", error)
            self.assertEqual(self.request("context.cookies", {"context": self.context}), [])
            self.assertEqual(self.events, [], "unreturned pages must not publish object events")
        self.assertIsNone(self.driver.poll())


class BrowserAllocationLimitTests(OwnedDriverCase):
    resource_limits = {"controlFrameBytes": 32768, "valueNodes": 3}

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="flashwright-output-limits-")
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(self.assert_private_browser_released)
        self.driver_environment = {"TMPDIR": self.directory.name}
        self.start_driver()

    def assert_private_browser_released(self):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            processes = snapshot()
            children = [process for process, (parent, _) in processes.items() if parent == self.driver.pid]
            profiles = list(Path(self.directory.name).glob("flashwright-chromium-*"))
            if not children and not profiles:
                return
            time.sleep(0.05)
        self.fail(f"unreturned browser left children or a profile: {children}, {profiles}")

    def test_rejected_browser_allocations_release_the_guardian_and_profile(self):
        for _attempt in range(2):
            error = expect_resource_error(self, "browser.launch", {"executablePath": os.environ["FLASHWRIGHT_BROWSER_PATH"]})
            self.assertIn(error["cleanup"], ["resourceDisposed", "guardianContinuingCleanup"], error)
            self.assert_private_browser_released()
            self.assertEqual(self.events, [], "unreturned browsers must not publish disconnect events")
        self.send(self.command("unknown.operation", {}))
        self.assertEqual(self.receive()["error"]["code"], "UnsupportedFeatureError")
