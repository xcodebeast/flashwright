#!/usr/bin/env python3
"""Observe original console sessions and object custody without changing protocol bytes."""
import importlib.util
import json
from pathlib import Path
import sys

source = Path(__file__).with_name("network-renderer-proxy.py")
specification = importlib.util.spec_from_file_location("console_session_proxy", source)
network = importlib.util.module_from_spec(specification)
specification.loader.exec_module(network)


class ConsoleRecorder(network.NetworkRecorder):
    def message(self, direction, timestamp, message):
        super().message(direction, timestamp, message)
        envelope = json.loads(message)
        method, parameters = envelope.get("method", ""), envelope.get("params", {})
        metadata = None
        if method == "Runtime.consoleAPICalled":
            metadata = network.select(parameters, ["executionContextId", "type"])
            metadata["arguments"] = [network.select(value, ["objectId", "type", "subtype", "value"])
                                     for value in parameters.get("args", [])]
        elif method == "Runtime.executionContextCreated":
            metadata = {"context": network.select(parameters["context"], ["id", "uniqueId", "auxData"])}
        elif method == "Runtime.executionContextDestroyed":
            metadata = network.select(parameters, ["executionContextId", "executionContextUniqueId"])
        elif method == "Runtime.executionContextsCleared":
            metadata = {}
        elif method == "Page.frameNavigated":
            metadata = {"frame": network.select(parameters.get("frame", {}), ["id", "parentId", "url"])}
        elif method == "Target.detachedFromTarget":
            metadata = network.select(parameters, ["sessionId"])
        elif method in ["Runtime.callFunctionOn", "Runtime.releaseObject"]:
            metadata = network.select(parameters, ["objectId", "uniqueContextId", "executionContextId"])
            metadata["argumentObjectIds"] = [value["objectId"] for value in parameters.get("arguments", []) if "objectId" in value]
        if metadata is not None:
            self.write({"kind": "consoleOwnership", "direction": direction, "method": method,
                        "id": envelope.get("id"), "monotonicNanoseconds": str(timestamp),
                        "sessionId": envelope.get("sessionId"), "parameters": metadata})


if __name__ == "__main__":
    sys.argv.append("--site-per-process")
    network.proxy.Recorder = ConsoleRecorder
    sys.exit(network.proxy.main())
