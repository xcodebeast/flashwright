#!/usr/bin/env python3
"""Reuse the supervised pipe proxy while retaining exact dialog-only wire frames."""

import base64
import importlib.util
import json
from pathlib import Path
import sys

source = Path(__file__).resolve().parents[1] / "benchmarks/protocol-proxy.py"
specification = importlib.util.spec_from_file_location("dialog_pipe_proxy", source)
proxy = importlib.util.module_from_spec(specification)
specification.loader.exec_module(proxy)


class DialogRecorder(proxy.Recorder):
    def calibrate_clock(self, phase):
        # This is a value-characterization probe, never a latency or throughput sample.
        pass

    def message(self, direction, timestamp, message):
        super().message(direction, timestamp, message)
        envelope = json.loads(message)
        if envelope.get("method") in ["Page.javascriptDialogOpening", "Page.javascriptDialogClosed", "Page.handleJavaScriptDialog"]:
            self.write({"kind": "dialogWire", "direction": direction, "monotonicNanoseconds": str(timestamp), "rawBase64": base64.b64encode(message).decode("ascii")})


proxy.Recorder = DialogRecorder
sys.exit(proxy.main())
