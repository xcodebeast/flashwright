#!/usr/bin/env python3
"""Execute an intentional-crash fixture without invoking host core-dump handlers."""

import os
import resource
import sys


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: process-fault-fixture.py COMMAND [ARGUMENT ...]")
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    # Exec preserves PID, process group, streams, environment and exit status.
    os.execvp(sys.argv[1], sys.argv[1:])
