#!/usr/bin/env python3
"""Hold one genuine setup reply and forward Chromium's actual root-detachment event."""

import importlib.util
import json
import os
from pathlib import Path
import sys
import threading
import time

source = Path(__file__).resolve().parents[1] / "benchmarks/protocol-proxy.py"
specification = importlib.util.spec_from_file_location("initialization_proxy", source)
proxy = importlib.util.module_from_spec(specification)
specification.loader.exec_module(proxy)
setup_method = os.environ["FLASHWRIGHT_INITIALIZATION_METHOD"]
detach_identifier = 2000000000
destinations = {}
write_locks = {"send": threading.Lock(), "receive": threading.Lock()}


def write_message(direction, message):
    """Serialize injected commands with ordinary complete protocol frames."""
    with write_locks[direction]:
        remaining = memoryview(message + b"\0")
        while remaining:
            remaining = remaining[os.write(destinations[direction], remaining):]


class InitializationRecorder(proxy.Recorder):
    def __init__(self, *arguments):
        super().__init__(*arguments)
        self.setup_identifier = None
        self.root_session = None
        self.reply_held = False

    def calibrate_clock(self, phase):
        pass

    def transform(self, direction, message):
        """Detach only the first original page; later pages exercise context recovery."""
        envelope = json.loads(message)
        method = envelope.get("method")
        records = []
        detach = None
        forward = True
        with self.lock:
            if direction == "send" and method == setup_method and self.setup_identifier is None:
                self.setup_identifier = envelope["id"]
                self.root_session = envelope["sessionId"]
            if direction == "receive" and self.setup_identifier is not None:
                if envelope.get("id") == self.setup_identifier:
                    if "error" in envelope:
                        raise ValueError("Selected setup command failed before fault injection")
                    self.reply_held = True
                    forward = False
                    detach = self.root_session
                    records.append({"kind": "setupReplyHeld", "method": setup_method})
                elif envelope.get("id") == detach_identifier:
                    forward = False
                    records.append({"kind": "nativeDetachReply", "error": envelope.get("error")})
                elif method == "Target.detachedFromTarget" and envelope.get("params", {}).get("sessionId") == self.root_session:
                    records.append({"kind": "originalRootDetached", "replyStillHeld": self.reply_held})
        for record in records:
            self.write(record)
        if detach is not None:
            self.write({"kind": "nativeDetachRequested", "sessionId": detach})
            write_message("send", json.dumps({"id": detach_identifier, "method": "Target.detachFromTarget", "params": {"sessionId": detach}}).encode())
        return [message] if forward else []


def forward(source, destination, direction, recorder):
    destinations[direction] = destination
    pending = bytearray()
    while chunk := os.read(source, 65536):
        pending.extend(chunk)
        while (boundary := pending.find(0)) != -1:
            message = bytes(pending[:boundary])
            del pending[:boundary + 1]
            if len(message) > proxy.MAXIMUM_MESSAGE_BYTES:
                raise ValueError("Initialization probe message exceeds its retention limit")
            recorder.message(direction, time.monotonic_ns(), message)
            for transformed in recorder.transform(direction, message):
                write_message(direction, transformed)
        if len(pending) > proxy.MAXIMUM_MESSAGE_BYTES:
            raise ValueError("Initialization probe pending frame exceeds its retention limit")
    if pending:
        raise ValueError("Initialization probe ended inside a protocol message")


if __name__ == "__main__":
    proxy.Recorder = InitializationRecorder
    proxy.forward = forward
    sys.exit(proxy.main())
