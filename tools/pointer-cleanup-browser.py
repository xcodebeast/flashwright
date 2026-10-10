#!/usr/bin/env python3
"""Relay a real Chromium pipe and inject a bounded pointer cleanup failure."""

import json
import os
import select
import socket
import subprocess
import sys


mode = os.environ['FLASHWRIGHT_POINTER_CLEANUP_MODE']
browser_path = os.environ['FLASHWRIGHT_POINTER_CLEANUP_BROWSER']
log = open(os.environ['FLASHWRIGHT_POINTER_CLEANUP_LOG'], 'x', buffering=1)
browser_input, child_input = socket.socketpair()
child_output, browser_output = socket.socketpair()


def connect_pipes():
    os.dup2(child_input.fileno(), 3)
    os.dup2(child_output.fileno(), 4)


browser = subprocess.Popen([browser_path, *sys.argv[1:]],
                           pass_fds=(3, 4, child_input.fileno(), child_output.fileno()),
                           preexec_fn=connect_pipes)
child_input.close()
child_output.close()
buffers = {3: bytearray(), browser_output.fileno(): bytearray()}
contexts = {}
attaching = {}
targets = {}
armed = False
triggered = False
token = None
probe_identifier = 1000000000
pending_probe = None
withheld_identifier = None


def record(event, **fields):
    log.write(json.dumps({'event': event, **fields}) + '\n')


def send_driver(message):
    payload = json.dumps(message).encode() + b'\0'
    while payload:
        payload = payload[os.write(4, payload):]


def send_browser(message):
    browser_input.sendall(json.dumps(message).encode() + b'\0')


def reject(command):
    send_driver({'id': command['id'], 'sessionId': command.get('sessionId'),
                 'error': {'code': -32000, 'message': 'Injected cleanup rejection'}})


def from_driver(command):
    global armed, triggered, token, pending_probe
    method = command['method']
    parameters = command.get('params', {})
    function = parameters.get('functionDeclaration', '')
    if method == 'Target.attachToTarget':
        attaching[command['id']] = parameters['targetId']
    if 'return globalThis.__flashwrightLocatorRuntime.armPointer(' in function:
        armed = True
    if armed and not triggered and method == 'Runtime.releaseObjectGroup':
        triggered = True
        token = parameters['objectGroup']
        session = command['sessionId']
        frame = contexts[session]
        record('semanticFailure', session=session, token=token, frame=frame, target=targets[session])
        # No physical target or context destruction accompanies this metadata failure.
        send_driver({'method': 'Runtime.executionContextCreated', 'sessionId': session,
                     'params': {'context': {'id': 999999, 'auxData': {
                         'isDefault': False, 'frameId': frame}}}})
        return
    if triggered:
        if 'cleanupPointer(token)' in function:
            record('residentCleanup', session=command.get('sessionId'),
                   context=parameters.get('uniqueContextId'))
            pending_probe = command
            send_browser({'id': probe_identifier, 'method': 'Runtime.callFunctionOn',
                          'sessionId': command['sessionId'], 'params': {
                              'uniqueContextId': parameters['uniqueContextId'],
                              'functionDeclaration': 'function(token) { return !!globalThis.__flashwrightLocatorRuntime.pointerElement(token); }',
                              'arguments': [{'value': token}], 'returnByValue': True}})
            return
        if method == 'Runtime.releaseObjectGroup' and parameters.get('objectGroup') == token:
            record('groupCleanup', session=command.get('sessionId'), token=token)
            if mode == 'group-rejection':
                reject(command)
                return
        if method.startswith('Input.') or method == 'Target.closeTarget':
            record('commandAfterFailure', method=method, parameters=parameters)
    send_browser(command)


def from_browser(message):
    global pending_probe, withheld_identifier
    if message.get('id') in attaching:
        targets[message['result']['sessionId']] = attaching.pop(message['id'])
    if message.get('method') == 'Runtime.executionContextCreated':
        context = message['params']['context']
        frame = context.get('auxData', {}).get('frameId')
        if frame:
            contexts[message['sessionId']] = frame
    if message.get('id') == probe_identifier:
        record('liveResidentProbe', response=message)
        command, pending_probe = pending_probe, None
        if mode == 'resident-rejection':
            reject(command)
        else:
            if mode == 'resident-timeout':
                withheld_identifier = command['id']
            send_browser(command)
        return
    if message.get('id') == withheld_identifier and withheld_identifier is not None:
        record('withheldCleanupReply', response=message)
        return
    send_driver(message)


try:
    while browser.poll() is None:
        readable, _, _ = select.select(list(buffers), [], [], 0.1)
        for descriptor in readable:
            data = os.read(descriptor, 65536)
            if not data:
                raise EOFError()
            buffer = buffers[descriptor]
            buffer.extend(data)
            while 0 in buffer:
                boundary = buffer.index(0)
                message = json.loads(buffer[:boundary])
                del buffer[:boundary + 1]
                (from_driver if descriptor == 3 else from_browser)(message)
except (EOFError, BrokenPipeError):
    pass
finally:
    if browser.poll() is None:
        browser.terminate()
        try:
            browser.wait(timeout=5)
        except subprocess.TimeoutExpired:
            browser.kill()
            browser.wait()
    record('browserExit', code=browser.returncode)
    log.close()
