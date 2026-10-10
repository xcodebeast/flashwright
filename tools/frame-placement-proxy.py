#!/usr/bin/env python3
"""Observe frame ownership through the existing supervised, byte-preserving pipe relay.

Functional diagnostics only. Retain reviewed frame metadata, never evaluation values,
script text, console messages or arbitrary protocol payloads.
"""

import importlib.util
import json
from pathlib import Path
import sys

source = Path(__file__).resolve().parents[1] / "benchmarks/protocol-proxy.py"
specification = importlib.util.spec_from_file_location("frame_pipe_proxy", source)
proxy = importlib.util.module_from_spec(specification)
specification.loader.exec_module(proxy)


def fields(value, names):
    return {name: value[name] for name in names if name in value}


def frame_metadata(envelope):
    method = envelope.get("method")
    parameters = envelope.get("params", {})
    if method == "Page.frameNavigated":
        return {"frame": fields(parameters.get("frame", {}), ["id", "parentId", "url", "name"])}
    if method == "Page.frameAttached":
        return fields(parameters, ["frameId", "parentFrameId"])
    if method == "Page.frameDetached":
        return fields(parameters, ["frameId", "reason"])
    if method in ["Target.attachedToTarget", "Target.targetInfoChanged", "Target.targetCreated"]:
        return fields(parameters, ["sessionId"]) | {"targetInfo": fields(parameters.get("targetInfo", {}), ["targetId", "type", "parentFrameId", "url"])}
    if method == "Target.targetDestroyed":
        return fields(parameters, ["targetId"])
    if method == "Target.detachedFromTarget":
        return fields(parameters, ["sessionId", "targetId"])
    if method == "Runtime.executionContextCreated":
        context = parameters.get("context", {})
        return {"context": fields(context, ["id", "uniqueId"]) | {"auxData": fields(context.get("auxData", {}), ["frameId", "isDefault"])}}
    if method == "Runtime.executionContextDestroyed":
        return fields(parameters, ["executionContextId", "executionContextUniqueId"])
    if method == "Runtime.executionContextsCleared":
        return {}
    return None


class FrameRecorder(proxy.Recorder):
    def calibrate_clock(self, phase):
        # These records establish ownership, not comparable timings.
        pass

    def message(self, direction, timestamp, message):
        super().message(direction, timestamp, message)
        if direction != "receive":
            return
        envelope = json.loads(message)
        metadata = frame_metadata(envelope)
        if metadata is not None:
            self.write({"kind": "frameMetadata", "method": envelope["method"],
                        "sessionId": envelope.get("sessionId"), "parameters": metadata})


if __name__ == "__main__":
    proxy.Recorder = FrameRecorder
    sys.exit(proxy.main())
