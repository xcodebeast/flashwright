#!/usr/bin/env bash
set -euo pipefail
mkdir -p /workspace /output
tar -C /source --exclude=.git --exclude=.tools --exclude=.cache --exclude=node_modules --exclude=target --exclude='packages/*/dist' --exclude=test-results --exclude=benchmarks/results --exclude=compatibility/evidence -cf - . | tar -C /workspace -xf -
cd /workspace
mkdir -p .cache compatibility/evidence
export PATH="$HOME/.cargo/bin:$PATH"
archive_results() {
 mkdir -p /output/evidence
 cp -R compatibility/evidence/. /output/evidence/
 if [ -f target/debug/flashwright-driver ]; then
  cp target/debug/flashwright-driver /output/flashwright-driver-linux-x64
  sha256sum /output/flashwright-driver-linux-x64 > /output/driver-sha256.txt
 fi
 rustc --version > /output/rust-version.txt
}
trap archive_results EXIT
npm ci --ignore-scripts --no-audit --no-fund
cargo build --workspace --locked
node tools/build-packages.mjs
node --input-type=module -e "import {sourceManifest} from './tools/source-manifest.mjs'; import {writeFile} from 'node:fs/promises'; await writeFile('/output/sources.json',JSON.stringify(await sourceManifest(),null,2));"
export FLASHWRIGHT_DRIVER_PATH=/workspace/target/debug/flashwright-driver
export FLASHWRIGHT_TEST_NODE=/usr/bin/node
result=0
for pattern in output_limits.py test_public_lifecycle.py watchdog_lifecycle.py; do
 python3 tools/watchdog.py --timeout 180 --report-directory compatibility/evidence/resources -- python3 -m unittest discover -s compatibility/m1 -p "$pattern" -v || result=1
done
exit "$result"
