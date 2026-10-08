#!/usr/bin/env python3
"""Forward Chromium's exact pipe bytes and retain payload-free attribution records.

This development-only proxy adds processes and parsing work. Its runs measure command
counts and acknowledgement intervals, never production engine speed.
"""

import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import sys
import threading
import time


MAXIMUM_MESSAGE_BYTES = 8 * 1024 * 1024


class Recorder:
    def __init__(self, output, clock_port=None):
        self.output = output
        self.lock = threading.Lock()
        self.clock_port = clock_port

    def write(self, record):
        with self.lock:
            self.output.write(json.dumps(record, separators=(",", ":")) + "\n")
            self.output.flush()

    def message(self, direction, timestamp, message):
        envelope = json.loads(message)
        if direction == "send" and envelope.get("method") == "Browser.close" and self.clock_port:
            self.calibrate_clock("beforeBrowserClose")
        record = {"kind": direction, "monotonicNanoseconds": str(timestamp), "bytes": len(message) + 1}
        for field in ["id", "method", "sessionId"]:
            if field in envelope:
                record[field] = envelope[field]
        if "id" in envelope and direction == "receive":
            record["error"] = "error" in envelope
        if direction == "send" and envelope.get("method") in ["Runtime.evaluate", "Runtime.callFunctionOn"]:
            parameters = envelope.get("params", {})
            source = parameters.get("functionDeclaration", parameters.get("expression", ""))
            encoded = source.encode("utf-16-le", errors="surrogatepass")
            record["scriptSha256"] = hashlib.sha256(encoded).hexdigest()
            record["scriptUtf16Units"] = len(encoded) // 2
        self.write(record)

    def calibrate_clock(self, phase):
        """Bracket Node's clock with proxy timestamps; their epochs differ on macOS."""
        samples = []
        with socket.create_connection(("127.0.0.1", self.clock_port), timeout=2) as connection:
            reader = connection.makefile("rb")
            for _ in range(16):
                before = time.monotonic_ns()
                connection.sendall(b"clock\n")
                node_timestamp = int(reader.readline())
                after = time.monotonic_ns()
                samples.append({"before": str(before), "node": str(node_timestamp), "after": str(after)})
        self.write({"kind": "clock", "phase": phase, "samples": samples})


def forward(source, destination, direction, recorder):
    """Retain metadata before the last bytes can trigger shutdown; preserve exact wire bytes."""
    pending = bytearray()
    while chunk := os.read(source, 65536):
        timestamp = time.monotonic_ns()
        pending.extend(chunk)
        while (boundary := pending.find(0)) != -1:
            message = bytes(pending[:boundary])
            del pending[:boundary + 1]
            if len(message) > MAXIMUM_MESSAGE_BYTES:
                raise ValueError("Chromium trace message exceeded its retention limit")
            recorder.message(direction, timestamp, message)
        if len(pending) > MAXIMUM_MESSAGE_BYTES:
            raise ValueError("Chromium trace message exceeded its retention limit")
        remaining = memoryview(chunk)
        while remaining:
            remaining = remaining[os.write(destination, remaining):]
    if pending:
        raise ValueError("Chromium pipe ended inside a protocol message")


def main():
    browser = Path(os.environ["FLASHWRIGHT_PROFILE_BROWSER_PATH"]).resolve(strict=True)
    directory = Path(os.environ["FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY"])
    directory.mkdir(parents=True, exist_ok=True)
    trace_path = directory / f"protocol-{os.getpid()}.jsonl"
    with trace_path.open("x") as output:
        recorder = Recorder(output)
        recorder.write({"kind": "launch", "monotonicNanoseconds": str(time.monotonic_ns()), "browser": str(browser), "arguments": sys.argv[1:]})
        browser_input, outgoing = os.pipe()
        incoming, browser_output = os.pipe()
        child = os.posix_spawn(str(browser), [str(browser), *sys.argv[1:]], os.environ, file_actions=[
            (os.POSIX_SPAWN_DUP2, browser_input, 3),
            (os.POSIX_SPAWN_DUP2, browser_output, 4),
        ])
        os.close(browser_input)
        os.close(browser_output)
        failures = []

        def pump(source, destination, direction):
            try:
                forward(source, destination, direction, recorder)
            except BrokenPipeError:
                # Browser.close can race the writer; retain the failure for the verifier.
                failures.append(f"{direction}: broken pipe")
            except Exception as error:
                failures.append(f"{direction}: {error}")
                try:
                    os.kill(child, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            finally:
                try:
                    os.close(destination)
                except OSError:
                    pass

        sending = threading.Thread(target=pump, args=(3, outgoing, "send"), daemon=True)
        receiving = threading.Thread(target=pump, args=(incoming, 4, "receive"), daemon=True)
        sending.start()
        receiving.start()
        _, status = os.waitpid(child, 0)
        receiving.join(timeout=2)
        if receiving.is_alive():
            failures.append("browser exited without closing the response pipe")
        recorder.write({"kind": "exit", "monotonicNanoseconds": str(time.monotonic_ns()), "exitCode": os.waitstatus_to_exitcode(status), "failures": failures})
        exit_code = os.waitstatus_to_exitcode(status)
        return 1 if failures else exit_code if exit_code >= 0 else 128 - exit_code


if __name__ == "__main__":
    sys.exit(main())
