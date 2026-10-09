#!/usr/bin/env python3
"""Delay one genuine handling reply while forwarding exact successor dialog frames."""

import base64
import importlib.util
import json
import os
from pathlib import Path
import select
import sys
import threading
import time

source = Path(__file__).resolve().parents[1] / "benchmarks/protocol-proxy.py"
specification = importlib.util.spec_from_file_location("dialog_late_reply_proxy", source)
proxy = importlib.util.module_from_spec(specification)
specification.loader.exec_module(proxy)
directory = Path(os.environ["FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY"])
identity_lock = threading.Lock()
first_handling_identifier = None


class DialogRecorder(proxy.Recorder):
    def calibrate_clock(self, phase):
        pass

    def message(self, direction, timestamp, message):
        global first_handling_identifier
        super().message(direction, timestamp, message)
        envelope = json.loads(message)
        if direction == "send" and envelope.get("method") == "Page.handleJavaScriptDialog":
            with identity_lock:
                if first_handling_identifier is None:
                    first_handling_identifier = envelope["id"]
        if envelope.get("method") in ["Page.handleJavaScriptDialog", "Page.javascriptDialogOpening", "Page.javascriptDialogClosed"]:
            self.write({"kind": "dialogWire", "direction": direction, "rawBase64": base64.b64encode(message).decode("ascii")})


def write_frame(destination, message):
    remaining = memoryview(message + b"\0")
    while remaining:
        remaining = remaining[os.write(destination, remaining):]


def forward(source, destination, direction, recorder):
    pending = bytearray()
    held_reply = None
    delayed = False
    while True:
        if held_reply is not None and (directory / "release").exists():
            write_frame(destination, held_reply)
            recorder.write({"kind": "releasedReply", "rawBase64": base64.b64encode(held_reply).decode("ascii")})
            held_reply = None
        if not select.select([source], [], [], 0.02)[0]:
            continue
        chunk = os.read(source, 65536)
        if not chunk:
            break
        pending.extend(chunk)
        while (boundary := pending.find(0)) != -1:
            message = bytes(pending[:boundary])
            del pending[:boundary + 1]
            if len(message) > proxy.MAXIMUM_MESSAGE_BYTES:
                raise ValueError("Chromium dialog probe message exceeded its bound")
            recorder.message(direction, time.monotonic_ns(), message)
            envelope = json.loads(message)
            with identity_lock:
                should_delay = direction == "receive" and first_handling_identifier is not None and envelope.get("id") == first_handling_identifier
            if should_delay and not delayed:
                delayed = True
                held_reply = message
                record = {"kind": "heldReply", "rawBase64": base64.b64encode(message).decode("ascii")}
                recorder.write(record)
                (directory / "held.json").write_text(json.dumps(record) + "\n")
            else:
                write_frame(destination, message)
        if len(pending) > proxy.MAXIMUM_MESSAGE_BYTES:
            raise ValueError("Chromium dialog probe pending frame exceeded its bound")
    if pending or held_reply is not None:
        raise ValueError("Chromium dialog probe ended with undelivered bytes")


proxy.Recorder = DialogRecorder
proxy.forward = forward
sys.exit(proxy.main())
