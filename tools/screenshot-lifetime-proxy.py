#!/usr/bin/env python3
"""Hold genuine remote screenshot replies; functional fault evidence, never timing evidence."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import threading
import time

source = Path(__file__).with_name("page-initialization-detach-proxy.py")
os.environ.setdefault("FLASHWRIGHT_INITIALIZATION_METHOD", "unused")
spec = importlib.util.spec_from_file_location("screenshot_lifetime_relay", source)
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)
directory = Path(os.environ["FLASHWRIGHT_SCREENSHOT_LIFETIME_DIRECTORY"])


class ScreenshotRecorder(relay.proxy.Recorder):
    def __init__(self, *args):
        super().__init__(*args)
        self.pending = {}
        self.selected = set()
        self.remote = set()

    def calibrate_clock(self, phase):
        pass

    def release(self, message, label):
        while not (directory / f"release-{label}").exists():
            time.sleep(0.005)
        relay.write_message("receive", message)
        self.write({"kind": "screenshotReplyReleased", "label": label})
        (directory / f"released-{label}").touch()

    def transform(self, direction, message):
        envelope = json.loads(message)
        method = envelope.get("method")
        params = envelope.get("params", {})
        session = envelope.get("sessionId")
        if direction == "send":
            if method == "Target.detachFromTarget":
                self.write({"kind": "detachRequested", "session": params.get("sessionId")})
            phase = None
            if method == "Runtime.evaluate" and "function createScreenshotCapture" in params.get("expression", ""):
                phase = "prepare"
            elif method == "Runtime.callFunctionOn" and params.get("functionDeclaration") == "function() { this.restore(); }":
                phase = "restore"
            elif method == "Runtime.releaseObject":
                phase = "release"
            if phase:
                record = {"kind": "screenshotSent", "phase": phase, "id": envelope["id"], "session": session,
                          "context": params.get("uniqueContextId"), "object": params.get("objectId"),
                          "remote": session in self.remote}
                control = directory / "control.json"
                if control.exists() and record["remote"]:
                    selected = json.loads(control.read_text())
                    if selected["phase"] == phase and selected["label"] not in self.selected:
                        self.selected.add(selected["label"])
                        record["label"] = selected["label"]
                self.pending[envelope["id"]] = record
                self.write(record)
        elif "id" in envelope:
            record = self.pending.pop(envelope["id"], None)
            if record:
                result = envelope.get("result", {})
                reply = {**record, "kind": "screenshotReply", "object": result.get("result", {}).get("objectId", record["object"]),
                         "error": envelope.get("error"), "exception": result.get("exceptionDetails")}
                self.write(reply)
                if "label" in record:
                    if reply["error"] or reply["exception"] or record["phase"] == "prepare" and not reply["object"]:
                        raise ValueError("Native screenshot command failed before reply hold")
                    label = record["label"]
                    (directory / f"held-{label}.json").write_text(json.dumps(reply))
                    threading.Thread(target=self.release, args=(message, label), daemon=True).start()
                    return []
        elif method == "Target.attachedToTarget" and params.get("targetInfo", {}).get("type") == "iframe":
            self.remote.add(params["sessionId"])
            self.write({"kind": "remoteAttached", "session": params["sessionId"]})
        elif method in ["Runtime.executionContextsCleared", "Runtime.executionContextDestroyed", "Target.detachedFromTarget"]:
            self.write({"kind": "nativeLifetime", "method": method, "session": session, "params": params})
        return [message]


if __name__ == "__main__":
    sys.argv.append("--site-per-process")
    relay.proxy.Recorder = ScreenshotRecorder
    relay.proxy.forward = relay.forward
    sys.exit(relay.proxy.main())
