#!/usr/bin/env python3
"""Hold a genuine keyboard/capture acknowledgement for native lifetime controls."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import threading
import time

source = Path(__file__).with_name('page-initialization-detach-proxy.py')
os.environ.setdefault('FLASHWRIGHT_INITIALIZATION_METHOD', 'unused')
spec = importlib.util.spec_from_file_location('keyboard_snapshot_relay', source)
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)
directory = Path(os.environ['FLASHWRIGHT_KEYBOARD_SNAPSHOT_DIRECTORY'])


class Recorder(relay.proxy.Recorder):
    def __init__(self, *args):
        super().__init__(*args)
        self.pending = {}
        self.selected = set()

    def calibrate_clock(self, phase):
        pass

    def release(self, message, label):
        while not (directory / f'release-{label}').exists():
            time.sleep(0.005)
        relay.write_message('receive', message)
        self.write({'kind': 'heldReplyReleased', 'label': label})

    def transform(self, direction, message):
        envelope = json.loads(message)
        parameters = envelope.get('params', {})
        if direction == 'send':
            capture = envelope.get('method') == 'Runtime.callFunctionOn' and 'return this.capture({token:' in parameters.get('functionDeclaration', '')
            key_up = envelope.get('method') == 'Input.dispatchKeyEvent' and parameters.get('type') == 'keyUp' and parameters.get('key') == 'x'
            if capture:
                self.write({'kind': 'snapshotSent', 'id': envelope['id']})
            control = directory / 'control.json'
            if control.exists():
                selected = json.loads(control.read_text())
                label = selected['label']
                if label not in self.selected and ((selected['mode'] == 'capture' and capture) or (selected['mode'] == 'key' and key_up)):
                    self.selected.add(label)
                    self.pending[envelope['id']] = label
        elif 'id' in envelope:
            label = self.pending.pop(envelope['id'], None)
            if label:
                if 'error' in envelope or 'exceptionDetails' in envelope.get('result', {}):
                    raise ValueError('Selected genuine browser command failed before holding its reply')
                record = {'kind': 'nativeReplyHeld', 'label': label, 'id': envelope['id']}
                self.write(record)
                pending = directory / f'held-{label}.pending'
                pending.write_text(json.dumps(record))
                pending.replace(directory / f'held-{label}.json')
                threading.Thread(target=self.release, args=(message, label), daemon=True).start()
                return []
        return [message]


if __name__ == '__main__':
    relay.proxy.Recorder = Recorder
    relay.proxy.forward = relay.forward
    sys.exit(relay.proxy.main())
