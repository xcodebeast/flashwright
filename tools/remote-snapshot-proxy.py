#!/usr/bin/env python3
"""Byte-preserving renderer placement and snapshot-session evidence, never timing evidence."""
import importlib.util
import json
from pathlib import Path
import sys

source = Path(__file__).with_name("network-renderer-proxy.py")
specification = importlib.util.spec_from_file_location("snapshot_session_proxy", source)
network = importlib.util.module_from_spec(specification)
specification.loader.exec_module(network)


class SnapshotRecorder(network.NetworkRecorder):
    def message(self, direction, timestamp, message):
        super().message(direction, timestamp, message)
        envelope = json.loads(message)
        method, parameters = envelope.get("method", ""), envelope.get("params", {})
        kind = None
        if method == "Runtime.evaluate" and "function createSnapshotCapture" in parameters.get("expression", ""):
            kind = "factory"
        elif method == "Runtime.callFunctionOn" and "this.capture(" in parameters.get("functionDeclaration", ""):
            kind = "capture"
        elif method == "Runtime.callFunctionOn" and any(f"this.{operation}(" in parameters.get("functionDeclaration", "") for operation in ["commit", "discard", "retire"]):
            kind = "decisionOrRetirement"
        elif method in ["DOM.getFrameOwner", "Page.createIsolatedWorld", "Runtime.releaseObjectGroup"]:
            kind = method
        if kind:
            self.write({"kind": "snapshotOwnership", "operation": kind, "direction": direction,
                        "sessionId": envelope.get("sessionId"), "id": envelope.get("id"),
                        "parameters": network.select(parameters, ["frameId", "uniqueContextId", "objectGroup", "objectId"])})


if __name__ == "__main__":
    sys.argv.append("--site-per-process")
    network.proxy.Recorder = SnapshotRecorder
    sys.exit(network.proxy.main())
