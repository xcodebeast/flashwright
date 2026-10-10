"""A reused production build script must hash its current execution checkout."""

import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile

def current_build_script():
    """Use Cargo's artifact identity instead of guessing among stale cached executables."""
    execution = subprocess.run(
        ['cargo', 'build', '-p', 'flashwright-engine', '--locked', '--message-format=json'],
        capture_output=True, text=True,
    )
    sys.stderr.write(execution.stderr)
    execution.check_returncode()
    source = (Path.cwd() / 'crates/flashwright-engine/build.rs').resolve()
    candidates = set()
    for line in execution.stdout.splitlines():
        artifact = json.loads(line)
        target = artifact.get('target', {})
        if (artifact.get('reason') == 'compiler-artifact'
                and target.get('kind') == ['custom-build']
                and Path(target['src_path']).resolve() == source):
            filenames = artifact.get('filenames', [])
            if len(filenames) != 1 or not Path(filenames[0]).is_file():
                raise RuntimeError('Cargo must identify one existing engine build-script artifact')
            candidates.add(Path(filenames[0]).resolve())
    if len(candidates) != 1:
        raise RuntimeError(f'Cargo must identify one current engine build script, found {len(candidates)}')
    return candidates.pop()


if len(sys.argv) > 2:
    raise SystemExit('Usage: python3 tools/test-runtime-build-portability.py [build-script-executable]')
build_script = Path(sys.argv[1]).resolve() if len(sys.argv) == 2 else current_build_script()
results = []
with tempfile.TemporaryDirectory(prefix='flashwright-runtime-build-') as temporary:
    for name, contents in [('first', b'globalThis.first = true;\n'), ('second', b'globalThis.second = true;\n')]:
        checkout = Path(temporary, name)
        manifest_directory = checkout / 'crates' / 'flashwright-engine'
        manifest_directory.mkdir(parents=True)
        runtime = checkout / 'packages' / 'resident-runtime'
        runtime.mkdir(parents=True)
        (runtime / 'sources.txt').write_text('runtime.cjs\n')
        (runtime / 'runtime.cjs').write_bytes(contents)
        expected = hashlib.sha256(struct.pack('<Q', len(contents)) + contents).hexdigest()
        execution = subprocess.run([str(build_script)], cwd=manifest_directory,
                                   env={**os.environ, 'CARGO_MANIFEST_DIR': str(manifest_directory)},
                                   capture_output=True, text=True, check=True)
        hashes = [line.removeprefix('cargo:rustc-env=FLASHWRIGHT_RUNTIME_SHA256=')
                  for line in execution.stdout.splitlines()
                  if line.startswith('cargo:rustc-env=FLASHWRIGHT_RUNTIME_SHA256=')]
        results.append({'checkout': name, 'expected': expected, 'actual': hashes,
                        'passed': hashes == [expected]})
report = {'status': 'passed' if all(result['passed'] for result in results) else 'failed',
          'buildScriptSha256': hashlib.sha256(build_script.read_bytes()).hexdigest(),
          'results': results,
          'scope': 'The same production build script executable uses each execution checkout; no browser or release claim.'}
print(json.dumps(report))
sys.exit(0 if report['status'] == 'passed' else 1)
