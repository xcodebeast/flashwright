"""Own a private display and the original runner inside the external watchdog."""
from pathlib import Path
import ctypes, ctypes.util, hashlib, json, os, shutil, subprocess, sys, time

def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def describe_display():
    selected = os.environ.get('FLASHWRIGHT_XVFB_PATH') or shutil.which('Xvfb')
    assert selected, 'Install Xvfb or set FLASHWRIGHT_XVFB_PATH to its native executable'
    executable = Path(selected).resolve(strict=True)
    assert executable.is_file() and os.access(executable, os.X_OK)
    with executable.open('rb') as stream:
        assert stream.read(4) == b'\x7fELF', 'Select the native Xvfb executable, not a shell wrapper'
    files = {str(executable): digest(executable)}
    libraries = os.environ.get('FLASHWRIGHT_XVFB_LIBRARY_PATH')
    if libraries:
        directory = Path(libraries).resolve(strict=True)
        assert directory.is_dir()
        libraries = str(directory)
        for path in sorted(directory.rglob('*')):
            if path.is_file():
                files[str(path)] = digest(path)
    return {'executable': str(executable), 'privateLibraryDirectory': libraries,
            'inheritedLibraryPath': os.environ.get('LD_LIBRARY_PATH'), 'files': files}

def main():
    output = Path(sys.argv[1]).resolve()
    assert output.is_dir()
    inputs = json.loads((output / 'inputs.json').read_text())['displayInputs']
    assert describe_display() == inputs, 'Display inputs changed before launch'
    expected = inputs['files']
    report = {'status': 'failed', 'forcedKill': False, 'cleanupErrors': [], 'scope': 'Functional display and Cypress ownership only; no performance admission.'}
    display = runner = connection = None
    try:
        sockets = Path('/proc/net/unix').read_text().splitlines()
        number = next(n for n in range(190, 290)
                      if not os.path.lexists(f'/tmp/.X{n}-lock')
                      and not os.path.lexists(f'/tmp/.X11-unix/X{n}')
                      and not any(line.split()[-1].lstrip('@') == f'/tmp/.X11-unix/X{n}' for line in sockets))
        report['number'] = number
        command = [inputs['executable'], f':{number}', '-screen', '0', '1280x720x24', '-nolisten', 'tcp', '-noreset']
        report['displayCommand'] = command
        display_environment = dict(os.environ)
        if inputs['privateLibraryDirectory']:
            display_environment['LD_LIBRARY_PATH'] = inputs['privateLibraryDirectory'] + (':' + inputs['inheritedLibraryPath'] if inputs['inheritedLibraryPath'] else '')
        with (output / 'xvfb.log').open('xb') as log:
            display = subprocess.Popen(command, env=display_environment, stdout=log, stderr=log)
        report['displayPid'] = display.pid
        xlib = ctypes.CDLL(ctypes.util.find_library('X11'))
        xlib.XOpenDisplay.argtypes = [ctypes.c_char_p]
        xlib.XOpenDisplay.restype = ctypes.c_void_p
        xlib.XDefaultScreen.argtypes = [ctypes.c_void_p]
        xlib.XDefaultScreen.restype = ctypes.c_int
        xlib.XCloseDisplay.argtypes = [ctypes.c_void_p]
        for name in ['XDisplayWidth', 'XDisplayHeight', 'XDefaultDepth']:
            function = getattr(xlib, name)
            function.argtypes = [ctypes.c_void_p, ctypes.c_int]
            function.restype = ctypes.c_int
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            assert display.poll() is None, 'Private display exited before readiness'
            if Path(f'/tmp/.X11-unix/X{number}').exists():
                assert Path(f'/tmp/.X{number}-lock').read_text().strip() == str(display.pid)
                connection = xlib.XOpenDisplay(f':{number}'.encode())
                if connection:
                    break
            time.sleep(0.05)
        assert connection, 'Private X11 display unavailable'
        assert os.readlink(f'/proc/{display.pid}/exe') == inputs['executable']
        report['displayExecutable'] = inputs['executable']
        report['displayExecutableSha256'] = digest(inputs['executable'])
        report['displayLockOwner'] = int(Path(f'/tmp/.X{number}-lock').read_text().strip())
        screen = xlib.XDefaultScreen(connection)
        report['screen'] = {'width': xlib.XDisplayWidth(connection, screen), 'height': xlib.XDisplayHeight(connection, screen), 'depth': xlib.XDefaultDepth(connection, screen)}
        assert report['screen'] == {'width': 1280, 'height': 720, 'depth': 24}
        xlib.XCloseDisplay(connection)
        connection = None
        environment = dict(os.environ)
        for key in ['WAYLAND_DISPLAY', 'XAUTHORITY', 'ELECTRON_RUN_AS_NODE', 'CYPRESS_SKIP_VERIFY', 'IGNORE_CHROME_PREFERENCES']:
            environment.pop(key, None)
        for key, name in [('HOME', 'home'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache')]:
            path = output / name
            path.mkdir()
            environment[key] = str(path)
        environment['DISPLAY'] = f':{number}'
        environment['XDG_SESSION_TYPE'] = 'x11'
        environment['ELECTRON_OZONE_PLATFORM_HINT'] = 'x11'
        report['displayEnvironment'] = {key: environment[key] for key in ['DISPLAY', 'HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_SESSION_TYPE', 'ELECTRON_OZONE_PLATFORM_HINT']}
        report['runnerCommand'] = sys.argv[2:]
        runner = subprocess.Popen(sys.argv[2:], env=environment)
        report['runnerPid'] = runner.pid
        report['runnerExitCode'] = runner.wait(timeout=160)
        assert report['runnerExitCode'] == 0
        assert display.poll() is None, 'Private display died during runner execution'
        report['status'] = 'passed'
    finally:
        if connection:
            try:
                xlib.XCloseDisplay(connection)
            except BaseException as error:
                report['cleanupErrors'].append('XCloseDisplay: ' + repr(error))
        # One failed reap must not prevent the other original child from being
        # terminated/reaped. The external watchdog remains the final fallback.
        for name, child in [('runner', runner), ('display', display)]:
            if child is None:
                continue
            try:
                if child.poll() is None:
                    child.terminate()
                try:
                    report[name + 'ExitCode'] = child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    report['forcedKill'] = True
                    child.kill()
                    report[name + 'ExitCode'] = child.wait(timeout=5)
                if report[name + 'ExitCode'] != 0 or Path(f'/proc/{child.pid}').exists():
                    report['status'] = 'failed'
            except BaseException as error:
                report['cleanupErrors'].append(name + ': ' + repr(error))
        if 'number' in report:
            n = report['number']
            report['remainingDisplayPaths'] = [str(p) for p in [Path(f'/tmp/.X{n}-lock'), Path(f'/tmp/.X11-unix/X{n}')] if os.path.lexists(p)]
            if report['remainingDisplayPaths']:
                report['status'] = 'failed'
        if report['forcedKill'] or report['cleanupErrors']:
            report['status'] = 'failed'
        try:
            assert describe_display() == inputs, 'Display input set changed during execution'
        except BaseException as error:
            report['status'] = 'failed'
            report['cleanupErrors'].append('Display input set: ' + repr(error))
        for path, sha256 in expected.items():
            try:
                assert digest(path) == sha256, path
            except BaseException as error:
                report['status'] = 'failed'
                report['cleanupErrors'].append('Input recheck: ' + repr(error))
        with (output / 'display.json').open('x') as stream:
            json.dump(report, stream, indent=2)
    assert report['status'] == 'passed'

if __name__ == '__main__':
    if sys.argv[1:] == ['--describe']:
        print(json.dumps(describe_display()))
    else:
        main()
