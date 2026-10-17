#!/usr/bin/env python3
"""Retain native snapshot lifetime evidence and optionally hold a genuine retire reply."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import threading
import time

source = Path(__file__).with_name("page-initialization-detach-proxy.py")
os.environ.setdefault("FLASHWRIGHT_INITIALIZATION_METHOD", "unused")
spec = importlib.util.spec_from_file_location("snapshot_retirement_relay", source)
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)
directory = Path(os.environ["FLASHWRIGHT_SNAPSHOT_RETIREMENT_DIRECTORY"])


class RetirementRecorder(relay.proxy.Recorder):
    def __init__(self, *args):
        super().__init__(*args)
        self.pending = {}
        self.selected = set()

    def calibrate_clock(self, phase):
        pass

    def release(self, message, label):
        while not (directory / f"release-{label}").exists():
            time.sleep(0.005)
        relay.write_message("receive", message)
        self.write({"kind": "retirementReplyReleased", "label": label})

    def transform(self, direction, message):
        envelope = json.loads(message)
        method = envelope.get("method")
        params = envelope.get("params", {})
        session = envelope.get("sessionId")
        if direction == "send":
            kind = None
            if method == "Runtime.evaluate" and "function createSnapshotCapture" in params.get("expression", ""):
                kind = "factory"
            elif method == "Runtime.callFunctionOn" and params.get("functionDeclaration") == "function() { return this.retire(); }":
                kind = "retirement"
            if kind:
                record = {"kind": kind + "Sent", "id": envelope["id"], "session": session,
                          "context": params.get("uniqueContextId"), "object": params.get("objectId"),
                          "group": params.get("objectGroup")}
                control = directory / "control.json"
                if kind == "retirement" and control.exists():
                    label = json.loads(control.read_text())["label"]
                    if label not in self.selected:
                        self.selected.add(label)
                        record["label"] = label
                self.pending[envelope["id"]] = record
                self.write(record)
            if method == "Runtime.releaseObjectGroup":
                self.write({"kind": "groupReleased", "session": session, "group": params["objectGroup"]})
        elif "id" in envelope:
            record = self.pending.pop(envelope["id"], None)
            if record:
                result = envelope.get("result", {})
                reply = {**record, "kind": record["kind"].replace("Sent", "Reply"),
                         "object": result.get("result", {}).get("objectId", record["object"]),
                         "value": result.get("result", {}).get("value"), "error": envelope.get("error"),
                         "exception": result.get("exceptionDetails")}
                self.write(reply)
                if "label" in record:
                    if reply["error"] or reply["exception"] or reply["value"] is not True:
                        raise ValueError("Native retirement failed before reply hold")
                    label = record["label"]
                    (directory / f"held-{label}.json").write_text(json.dumps(reply))
                    threading.Thread(target=self.release, args=(message, label), daemon=True).start()
                    return []
        elif method in ["Runtime.executionContextsCleared", "Runtime.executionContextDestroyed", "Target.detachedFromTarget"]:
            self.write({"kind": "nativeLifetime", "method": method, "session": session, "params": params})
        return [message]


if __name__ == "__main__":
    relay.proxy.Recorder = RetirementRecorder
    relay.proxy.forward = relay.forward
    sys.exit(relay.proxy.main())
