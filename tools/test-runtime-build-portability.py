"""A reused production build script must hash its current execution checkout."""

import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile

build_script = Path(sys.argv[1]).resolve()
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
