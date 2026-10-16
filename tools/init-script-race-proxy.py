#!/usr/bin/env python3
"""Hold a selected genuine init-script reply; controls live in a private fixture directory."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import threading
import time

source = Path(__file__).with_name("page-initialization-detach-proxy.py")
os.environ.setdefault("FLASHWRIGHT_INITIALIZATION_METHOD", "unused")
spec = importlib.util.spec_from_file_location("init_race_relay", source)
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)
directory = Path(os.environ["FLASHWRIGHT_INIT_RACE_DIRECTORY"])


class RaceRecorder(relay.proxy.Recorder):
    def __init__(self, *args):
        super().__init__(*args)
        self.children = set()
        self.selected = None
        self.control = None

    def calibrate_clock(self, phase):
        pass

    def release(self, message):
        while not (directory / "release").exists():
            time.sleep(0.005)
        relay.write_message("receive", message)
        self.write({"kind": "heldReplyReleased"})

    def transform(self, direction, message):
        envelope = json.loads(message)
        method = envelope.get("method")
        parameters = envelope.get("params", {})
        if direction == "receive" and method == "Target.attachedToTarget" and parameters.get("targetInfo", {}).get("type") == "iframe":
            self.children.add(parameters["sessionId"])
            self.write({"kind": "remoteAttached", "session": parameters["sessionId"]})
        if direction == "receive" and method == "Target.detachedFromTarget":
            self.write({"kind": "nativeDetached", "session": parameters.get("sessionId")})
        if direction == "send":
            remote = envelope.get("sessionId") in self.children
            if method in ["Page.enable", "Page.addScriptToEvaluateOnNewDocument", "Page.removeScriptToEvaluateOnNewDocument", "Runtime.runIfWaitingForDebugger"]:
                self.write({"kind": "configurationCommand", "method": method, "remote": remote,
                            "session": envelope.get("sessionId"), "identifier": parameters.get("identifier"),
                            "raceSource": "raceMarker" in parameters.get("source", ""), "id": envelope["id"]})
            control = directory / "control.json"
            if self.selected is None and control.exists():
                candidate = json.loads(control.read_text())
                if method == candidate["method"] and remote == candidate["remote"]:
                    self.control = candidate
                    self.selected = envelope["id"]
                    self.selected_session = envelope.get("sessionId")
        if direction == "receive" and envelope.get("id") == self.selected and self.selected is not None:
            if "error" in envelope:
                raise ValueError("Selected genuine command failed before injection")
            held = {"id": self.selected, "session": self.selected_session, "nativeIdentifier": envelope.get("result", {}).get("identifier")}
            (directory / "held.json").write_text(json.dumps(held))
            self.write({"kind": "genuineReplyHeld", **held})
            if self.control.get("action") == "malformed":
                return [json.dumps({"id": self.selected, "sessionId": self.selected_session, "error": {"message": "injected malformed reply without code"}}).encode()]
            threading.Thread(target=self.release, args=(message,), daemon=True).start()
            return []
        return [message]


if __name__ == "__main__":
    relay.proxy.Recorder = RaceRecorder
    relay.proxy.forward = relay.forward
    sys.exit(relay.proxy.main())
