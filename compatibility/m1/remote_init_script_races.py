"""Force both configuration-lock orderings and original-session reply failures with real Chromium."""
import json
import os
from pathlib import Path
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from test_driver_protocol import OwnedDriverCase
from test_init_scripts import script_source


class RemoteInitScriptRaces(OwnedDriverCase):
    def setUp(self):
        super().setUp()
        self.directory = Path(os.environ["FLASHWRIGHT_INIT_RACE_DIRECTORY"])
        class Handler(BaseHTTPRequestHandler):
            def do_GET(handler):
                handler.send_response(200)
                handler.send_header("content-type", "text/html")
                handler.end_headers()
                handler.wfile.write(b"<script>if(parent!==window)parent.postMessage({marker:globalThis.raceMarker??null,path:location.pathname},'*');else addEventListener('message',e=>{globalThis.childState=e.data});</script>")

            def log_message(self, *args):
                pass
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = self.server.server_port
        self.request("page.goto", {"page": self.page, "url": f"http://127.0.0.1:{self.port}/root", "waitUntil": "load"})

    def arm(self, method, remote, action="hold"):
        (self.directory / "control.json").write_text(json.dumps({"method": method, "remote": remote, "action": action}))

    def until(self, predicate):
        deadline = time.monotonic() + 5
        while not predicate():
            self.assertLess(time.monotonic(), deadline, "Expected original native observation")
            time.sleep(0.01)

    def held(self):
        self.until(lambda: (self.directory / "held.json").exists())
        return json.loads((self.directory / "held.json").read_text())

    def release(self):
        (self.directory / "release").touch()

    def records(self):
        return [json.loads(line) for path in Path(os.environ["FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY"]).glob("*.jsonl") for line in path.read_text().split("\n")[:-1]]

    def child(self, path="/child"):
        self.request("page.evaluate", self.evaluation(f"(() => {{ let f=document.querySelector('iframe'); if(!f){{f=document.createElement('iframe');document.body.append(f)}} f.src='http://localhost:{self.port}{path}'; }})()"))

    def state(self, expected, path="/child"):
        wanted = json.dumps({"marker": expected, "path": path}, separators=(",", ":"))
        self.until(lambda: self.request("page.evaluate", self.evaluation("JSON.stringify(globalThis.childState)")) == {"kind": "string", "units": list(wanted.encode())})

    def add(self, timeout=None):
        command = self.command("page.addInitScript", {"page": self.page, **script_source("globalThis.raceMarker = (globalThis.raceMarker ?? 0) + 1;")}, timeout=timeout)
        self.send(command)
        return command

    def result(self, command):
        reply = self.receive()
        self.assertEqual(reply["requestId"], command["requestId"], reply)
        self.assertEqual(reply["kind"], "result", reply)
        return reply["value"]

    def test_selected_race(self):
        mode = os.environ["FLASHWRIGHT_INIT_RACE_MODE"]
        if mode in ["writer-add", "writer-dispose", "reader-add", "reader-dispose"]:
            disposing = mode.endswith("dispose")
            if disposing:
                registration = self.result(self.add())
            writer_first = mode.startswith("writer")
            self.arm(("Page.removeScriptToEvaluateOnNewDocument" if disposing else "Page.addScriptToEvaluateOnNewDocument") if writer_first else "Page.enable", not writer_first)
            def change():
                if disposing:
                    command = self.command("initScript.dispose", {"script": registration["identifier"]}); self.send(command); return command
                return self.add()
            if writer_first:
                command = change(); self.held(); self.child()
                self.until(lambda: any(record["kind"] == "remoteAttached" for record in self.records()))
                self.assertFalse(any(record["kind"] == "configurationCommand" and record["remote"] for record in self.records()))
            else:
                self.child(); self.held(); command = change()
                # Keep the reader held while the registration request is queued.
                time.sleep(0.1)
            self.release(); self.result(command)
            self.state(1 if writer_first != disposing else None)
            self.child("/next"); self.state(None if disposing else 1, "/next")
        elif mode == "blocked-init-close":
            self.request("page.addInitScript", {"page": self.page, **script_source("if(location.hostname === 'localhost') { globalThis.raceMarker = 1; while(true){} }")})
            self.child()
            self.until(lambda: any(record["kind"] == "configurationCommand" and record["remote"] and record["raceSource"] for record in self.records()))
            waiter = self.add()
            closure = self.command("context.close", {"context": self.context}); self.send(closure)
            replies = {reply["requestId"]: reply for reply in [self.receive(), self.receive()]}
            self.assertEqual(replies[closure["requestId"]]["kind"], "result", replies)
            self.assertEqual(replies[waiter["requestId"]]["kind"], "error", replies)
        elif mode in ["late-add-cancel", "late-add-destroyed", "malformed-add", "remove-destroyed", "remove-timeout", "late-remove-cancel"]:
            self.child(); self.state(None)
            if mode.startswith("remove") or mode == "late-remove-cancel":
                registration = self.result(self.add())
                self.arm("Page.removeScriptToEvaluateOnNewDocument", True)
                command = self.command("initScript.dispose", {"script": registration["identifier"]}, timeout=100 if mode == "remove-timeout" else None)
                self.send(command); held = self.held()
                if mode == "late-remove-cancel":
                    self.send({"kind": "cancel", "requestId": command["requestId"]}); time.sleep(0.05); self.release()
                    reply = self.receive(); self.assertEqual(reply["error"]["code"], "CancelledError", reply)
                    self.assertEqual(reply["error"]["cleanup"], "initScriptDisposed", reply)
                    self.child("/next"); self.state(None, "/next")
                elif mode == "remove-destroyed":
                    removal = self.command("page.evaluate", self.evaluation("document.querySelector('iframe').remove()")); self.send(removal)
                    replies = {reply["requestId"]: reply for reply in [self.receive(), self.receive()]}
                    for pending in [command, removal]: self.assertEqual(replies[pending["requestId"]]["kind"], "result", replies)
                    self.assertTrue(any(record["kind"] == "nativeDetached" and record["session"] == held["session"] for record in self.records()))
                    self.child("/next"); self.state(None, "/next")
                else:
                    reply = self.receive(); self.assertEqual(reply["error"]["code"], "TimeoutError", reply)
                    self.send(self.command("page.evaluate", self.evaluation("42")))
                    self.assertEqual(self.receive()["error"]["code"], "TargetClosedError")
            else:
                self.arm("Page.addScriptToEvaluateOnNewDocument", True, "malformed" if mode == "malformed-add" else "hold")
                command = self.add(); held = self.held()
                if mode == "late-add-destroyed":
                    removal = self.command("page.evaluate", self.evaluation("document.querySelector('iframe').remove()")); self.send(removal)
                    replies = {reply["requestId"]: reply for reply in [self.receive(), self.receive()]}
                    for pending in [command, removal]: self.assertEqual(replies[pending["requestId"]]["kind"], "result", replies)
                    self.assertTrue(any(record["kind"] == "nativeDetached" and record["session"] == held["session"] for record in self.records()))
                    self.release()
                    self.child("/next"); self.state(1, "/next")
                    self.request("initScript.dispose", {"script": replies[command["requestId"]]["value"]["identifier"]})
                    self.child("/disposed"); self.state(None, "/disposed")
                    self.request("browser.close", {"browser": self.browser}); self.assert_resources_released()
                    return
                if mode == "late-add-cancel":
                    self.send({"kind": "cancel", "requestId": command["requestId"]}); time.sleep(0.05); self.release()
                reply = self.receive(); self.assertEqual(reply["requestId"], command["requestId"]); self.assertEqual(reply["kind"], "error", reply)
                if mode == "late-add-cancel":
                    self.assertEqual(reply["error"]["code"], "CancelledError", reply)
                    self.assertEqual(reply["error"]["cleanup"], "initScriptDisposed", reply)
                    self.assertTrue(any(record["kind"] == "configurationCommand" and record["method"] == "Page.removeScriptToEvaluateOnNewDocument" and record["session"] == held["session"] and record["identifier"] == held["nativeIdentifier"] for record in self.records()))
                    self.child("/next"); self.state(None, "/next")
                else:
                    self.assertEqual(reply["error"]["code"], "ProtocolError", reply)
                    self.send(self.command("page.evaluate", self.evaluation("42")))
                    self.assertEqual(self.receive()["error"]["code"], "TargetClosedError")
        else:
            self.fail("Unknown race mode")
        survivor = self.request("browser.newContext", {"browser": self.browser})["identifier"]
        page = self.request("context.newPage", {"context": survivor})["identifier"]
        self.assertEqual(self.request("page.evaluate", {**self.evaluation("42"), "page": page}), {"kind": "number", "value": 42})
        self.request("browser.close", {"browser": self.browser})
        self.assert_resources_released()


if __name__ == "__main__":
    unittest.main(verbosity=2)
