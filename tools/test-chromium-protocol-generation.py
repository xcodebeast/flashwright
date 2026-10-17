#!/usr/bin/env python3
"""Check patched Chromium protocol generators in an isolated Ninja fixture.

Usage: python3 -B tools/test-chromium-protocol-generation.py CHROMIUM_SOURCE
The source checkout must have tools/chromium/protocol-write-if-changed.patch.
"""
from pathlib import Path
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(source, relative, root):
    generator = root / 'generator'
    shutil.copytree(source / relative, generator, ignore=shutil.ignore_patterns(
        '.git', '__pycache__', '*.pyc'))
    schema = root / 'schema.json'
    config = root / 'config.json'
    output = root / 'generated'
    output.mkdir()
    config.write_text(json.dumps({'protocol': {
        'path': str(schema), 'package': 'protocol', 'output': 'protocol',
        'namespace': ['probe']}}))

    def change(commands):
        schema.write_text(json.dumps({'version': {'major': '1', 'minor': '0'},
                                     'domains': [{'domain': 'Probe',
                                                  'commands': [{'name': name} for name in commands]}]}))

    change(['ping'])
    command = [sys.executable, '-B', str(generator / 'code_generator.py'),
               '--jinja_dir', str(source / 'third_party'),
               '--output_base', str(output), '--config', str(config),
               '--inspector_protocol_dir', '//' + relative,
               '--depfile', 'generated/protocol.d',
               '--stamp', 'generated/protocol/Probe.h']
    (root / 'consume.py').write_text(
        "from pathlib import Path\nimport hashlib\n"
        "p=Path('count');p.write_text(str(int(p.read_text())+1) if p.exists() else '1')\n"
        "Path('consumer').write_text(hashlib.sha256(Path('generated/protocol/Probe.h').read_bytes()).hexdigest())\n")
    (root / 'build.ninja').write_text(
        'rule generate\n  command = ' + shlex.join(command).replace('$', '$$') +
        '\n  restat = 1\n  depfile = generated/protocol.d\n'
        'rule consume\n  command = ' + shlex.quote(sys.executable) + ' -B consume.py\n'
        'build generated/protocol/Probe.h generated/protocol/Probe.cpp: generate schema.json config.json\n'
        'build consumer: consume generated/protocol/Probe.h\ndefault consumer\n')
    ninja = source / 'third_party/ninja/ninja'
    steps = []

    def run(name, success=True):
        result = subprocess.run([str(ninja), '-C', str(root)], capture_output=True, text=True)
        (root / (name + '.log')).write_text(result.stdout + result.stderr)
        assert (result.returncode == 0) == success, (name, result.stdout, result.stderr)
        steps.append(name)

    count = lambda: int((root / 'count').read_text())
    header = output / 'protocol/Probe.h'
    run('initial')
    initial = header.read_bytes()
    stamp = header.stat().st_mtime_ns
    assert count() == 1
    change(['ping'])
    run('identical-input')
    assert count() == 1 and header.stat().st_mtime_ns == stamp
    run('no-op-after-restat')
    assert 'no work to do' in (root / 'no-op-after-restat.log').read_text()
    change(['ping', 'pong'])
    run('changed-input')
    assert count() == 2 and header.read_bytes() != initial
    changed = header.read_bytes()
    header.unlink()
    run('missing-output')
    assert count() == 3 and header.read_bytes() == changed
    header.write_bytes(b'\xffinvalid generated output')
    change(['ping', 'pong'])
    run('corrupt-output')
    assert count() == 4 and header.read_bytes() == changed
    if os.linesep == '\n':
        header.write_bytes(changed.replace(b'\n', b'\r\n'))
        change(['ping', 'pong'])
        run('foreign-newlines')
        assert count() == 5 and header.read_bytes() == changed
    header.unlink()
    header.mkdir()
    change(['ping', 'pong'])
    run('write-failure', success=False)
    header.rmdir()
    run('recover-after-failure')
    assert header.read_bytes() == changed
    # The same generator also supports a standalone stamp rather than using a
    # generated header as its depfile target.
    standalone = list(command)
    standalone[standalone.index('--stamp') + 1] = 'generated/standalone.stamp'
    old = header.stat().st_mtime_ns
    subprocess.run(standalone, cwd=root, check=True, capture_output=True)
    assert (output / 'standalone.stamp').exists() and header.stat().st_mtime_ns == old
    steps.append('standalone-stamp')
    return {'generator': relative, 'sourceSha256': digest(source / relative / 'code_generator.py'),
            'checks': steps, 'passed': True}


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    source = Path(sys.argv[1]).resolve(strict=True)
    workbench = Path(__file__).resolve().parents[1] / 'workbench'
    workbench.mkdir(exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix='protocol-generation-', dir=workbench))
    result = []
    for name, relative in [('blink', 'third_party/inspector_protocol'),
                           ('v8', 'v8/third_party/inspector_protocol')]:
        directory = root / name
        directory.mkdir()
        result.append(verify(source, relative, directory))
    (root / 'report.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'passed': True, 'report': str((root / 'report.json').relative_to(workbench.parent)),
                      'generators': result}))


if __name__ == '__main__':
    main()
