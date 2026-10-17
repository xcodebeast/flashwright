#!/usr/bin/env python3
"""Byte-preserving functional relay for renderer network ownership, not timing evidence."""
import importlib.util
import json
from pathlib import Path
import sys

source = Path(__file__).resolve().parents[1] / "benchmarks/protocol-proxy.py"
specification = importlib.util.spec_from_file_location("network_pipe_proxy", source)
proxy = importlib.util.module_from_spec(specification)
specification.loader.exec_module(proxy)


def select(value, names):
    return {name: value[name] for name in names if name in value}


class NetworkRecorder(proxy.Recorder):
    def calibrate_clock(self, phase):
        pass

    def message(self, direction, timestamp, message):
        super().message(direction, timestamp, message)
        envelope = json.loads(message)
        method, parameters = envelope.get("method", ""), envelope.get("params", {})
        metadata = None
        if method.startswith("Network."):
            metadata = select(parameters, ["requestId", "loaderId", "frameId", "type", "hasExtraInfo"])
            for name in ["request", "response"]:
                if name in parameters:
                    metadata[name] = select(parameters[name], ["url", "status"])
        elif method == "Page.frameNavigated":
            metadata = {"frame": select(parameters.get("frame", {}), ["id", "parentId", "loaderId", "url"])}
        elif method in ["Page.frameAttached", "Page.frameDetached"]:
            metadata = select(parameters, ["frameId", "parentFrameId", "reason"])
        elif method == "Target.attachedToTarget":
            metadata = select(parameters, ["sessionId"]) | {"targetInfo": select(parameters.get("targetInfo", {}), ["targetId", "type", "parentFrameId"])}
        elif method == "Target.detachedFromTarget":
            metadata = select(parameters, ["sessionId", "targetId"])
        if metadata is not None:
            self.write({"kind": "networkOwnership", "direction": direction, "method": method,
                        "sessionId": envelope.get("sessionId"), "parameters": metadata})


if __name__ == "__main__":
    # The shared fixture forces actual OOPIF placement on both engines.
    sys.argv.append("--site-per-process")
    proxy.Recorder = NetworkRecorder
    sys.exit(proxy.main())
