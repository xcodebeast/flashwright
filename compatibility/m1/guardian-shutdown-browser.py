"""A child that acknowledges shutdown before finishing its observable cleanup."""

import json
import os
import time

with os.fdopen(3, 'rb', buffering=0) as commands, os.fdopen(4, 'wb', buffering=0) as events:
    events.write((json.dumps({'process': os.getpid()}) + '\n').encode())
    if commands.read(1) == b'C':
        events.write(b'acknowledged\n')
        time.sleep(0.3)
        events.write(b'cleanup-complete\n')
