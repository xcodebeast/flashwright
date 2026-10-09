"""Upload assignments preserve captured ownership, no-replay and bounded private cleanup."""

import os
import signal
import struct
import tempfile
import threading

from test_driver_protocol import OwnedDriverCase
from output_limits import expect_resource_error


class FileInputTests(OwnedDriverCase):
    def prepare_input(self):
        self.request("page.evaluate", self.evaluation("document.body.innerHTML='<input type=file multiple>';globalThis.assignments=0;document.addEventListener('input',()=>assignments++);"))
        result = self.request("page.evaluateHandle", self.evaluation("document.querySelector('input')"))
        return {"page": self.page, "handle": result["handles"][0]["identifier"]}

    def parameters(self, payloads=None):
        return {"page": self.page, "frame": self.frame, "selector": list(b"input"), "strict": True,
                "files": {"payloads": payloads if payloads is not None else [{"name": list(b"data.bin"), "mimeType": list(b"application/octet-stream"), "offset": 0, "length": 4}]}}

    def upload(self, parameters, content=b"data", method="frame.setInputFiles", timeout=None):
        command = self.command(method, parameters, timeout)
        command["inputByteLength"] = len(content)
        self.send(command)
        for offset in range(0, len(content), 65536):
            body = b"\0" + struct.pack("<QI", command["requestId"], offset) + content[offset:offset + 65536]
            frame = struct.pack("<I", len(body)) + body
            while frame:
                frame = frame[os.write(self.driver.stdin.fileno(), frame):]
        self.send({"kind": "inputEnd", "requestId": command["requestId"], "aborted": False})
        return self.receive()

    def test_private_uploads_work_with_all_public_handle_slots_owned(self):
        handle = self.prepare_input()
        parent = self.request("page.evaluateHandle", self.evaluation("Object.fromEntries(Array.from({length:4094},(_,index)=>[index,{index}]))"))
        self.assertEqual(len(self.request("handle.getProperties", {"page": self.page, "handle": parent["handles"][0]["identifier"]})["handles"]), 4094)
        expect_resource_error(self, "page.evaluateHandle", self.evaluation("({})"))
        self.assertEqual(self.upload(self.parameters())["kind"], "result")
        self.assertEqual(self.upload({**handle, "files": {"payloads": []}}, b"", "elementHandle.setInputFiles")["kind"], "result")
        self.assertEqual(self.request("handle.evaluate", {**self.evaluation("input=>input.files.length"), **handle, "isFunction": True}), {"kind": "number", "value": 0})
        expect_resource_error(self, "page.evaluateHandle", self.evaluation("({})"))
        self.request("handle.dispose", handle)
        self.request("page.evaluateHandle", self.evaluation("({afterPrivateCleanup:true})"))

    def test_invalid_ranges_metadata_and_paths_have_no_file_events(self):
        handle = self.prepare_input()
        cases = [
            ({**self.parameters(), "files": {"payloads": [{"name": [], "mimeType": [], "offset": 1, "length": 3}]}}, b"data", "InvalidArgumentError"),
            ({**self.parameters(), "files": {"payloads": []}}, b"data", "InvalidArgumentError"),
            ({**self.parameters(), "files": {"paths": ["/file"], "payloads": []}}, b"", "InvalidArgumentError"),
            ({**self.parameters(), "files": {"payloads": [{"name": [65] * 524289, "mimeType": [], "offset": 0, "length": 0}]}}, b"", "ResourceLimitError"),
            ({**self.parameters(), "files": {"payloads": [{"name": [], "mimeType": [], "offset": 0, "length": 0}] * 4097}}, b"", "ResourceLimitError"),
        ]
        for parameters, content, expected in cases:
            reply = self.upload(parameters, content)
            self.assertEqual(reply["error"]["code"], expected)
            self.assertEqual(reply["error"]["inputDelivery"], "notDispatched")
        for path in ["relative", "/file\0name", "/file/../other"]:
            self.send(self.command("elementHandle.setInputFiles", {**handle, "files": {"paths": [path]}}))
            self.assertEqual(self.receive()["error"]["code"], "InvalidArgumentError")
        self.assertEqual(self.request("page.evaluate", self.evaluation("assignments===0 && document.querySelector('input').files.length===0")), {"kind": "boolean", "value": True})

    def test_cancelled_utility_adoption_has_no_late_assignment(self):
        handle = self.prepare_input()
        # Initialize the utility realm so the deadline tests alias ownership, not installation.
        self.assertEqual(self.upload({**handle, "files": {"payloads": []}}, b"", "elementHandle.setInputFiles")["kind"], "result")
        self.request("page.evaluate", self.evaluation("assignments=0"))
        os.kill(self.browser_process, signal.SIGSTOP)
        resume = threading.Timer(0.2, lambda: os.kill(self.browser_process, signal.SIGCONT))
        resume.start()
        try:
            reply = self.upload({**handle, "files": self.parameters()["files"]}, method="elementHandle.setInputFiles", timeout=40)
            self.assertEqual(reply["error"]["code"], "TimeoutError", reply)
            self.assertEqual(reply["error"]["inputDelivery"], "notDispatched", reply)
        finally:
            resume.join(timeout=2)
            os.kill(self.browser_process, signal.SIGCONT)
        self.assertEqual(self.request("page.evaluate", self.evaluation("assignments===0 && document.querySelector('input').files.length===0")), {"kind": "boolean", "value": True})
        self.assertEqual(self.upload({**handle, "files": self.parameters()["files"]}, method="elementHandle.setInputFiles")["kind"], "result")

    def test_blocked_file_handlers_are_not_replayed_and_sibling_survives(self):
        with tempfile.NamedTemporaryFile() as file:
            file.write(b"data")
            file.flush()
            for paths in [False, True]:
                with self.subTest(paths=paths):
                    page = self.request("context.newPage", {"context": self.context})
                    parameters = self.parameters()
                    parameters.update(page=page["identifier"], frame=page["mainFrame"])
                    self.request("page.evaluate", {**self.evaluation("document.body.innerHTML='<input type=file>';globalThis.assignments=0;document.querySelector('input').addEventListener('input',()=>{assignments++;while(true){}});"), "page": page["identifier"]})
                    if paths:
                        parameters["files"] = {"paths": [file.name]}
                        self.send(self.command("frame.setInputFiles", parameters, timeout=200))
                        reply = self.receive()
                    else:
                        reply = self.upload(parameters, timeout=200)
                    self.assertEqual(reply["error"]["code"], "TimeoutError", reply)
                    self.assertEqual(reply["error"]["inputDelivery"], "uncertain", reply)
                    self.assertIn(reply["error"]["cleanup"], ["handleGroupDisposed", "handleContextDestroyed", "pageClosedAfterUncertainHandleCleanup"], reply)
                    if reply["error"]["cleanup"] == "handleGroupDisposed":
                        self.assertEqual(self.request("page.evaluate", {**self.evaluation("assignments"), "page": page["identifier"]}), {"kind": "number", "value": 1})
                    self.assertEqual(self.request("page.evaluate", self.evaluation("42")), {"kind": "number", "value": 42})
                    self.request("page.close", {"page": page["identifier"]})
