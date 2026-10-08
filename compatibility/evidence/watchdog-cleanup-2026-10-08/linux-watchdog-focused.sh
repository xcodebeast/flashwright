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
export FLASHWRIGHT_TEST_NODE=/usr/bin/node
export FLASHWRIGHT_DRIVER_PATH=/workspace/target/debug/flashwright-driver
node --input-type=module -e 'import {sourceManifest} from "./tools/source-manifest.mjs"; import {writeFile} from "node:fs/promises"; await writeFile("/output/sources.json",JSON.stringify(await sourceManifest(),null,2)+"\n",{flag:"wx"});'
python3 tools/watchdog.py --timeout 180 --report-directory compatibility/evidence/resources -- python3 -m unittest discover -s compatibility/m1 -p watchdog_lifecycle.py -v
PYTHONPATH=compatibility/m1 python3 tools/watchdog.py --timeout 90 --report-directory compatibility/evidence/resources -- python3 -m unittest test_lifecycle.EngineLifecycleTests.test_renderer_deadline_can_interrupt_infinite_javascript test_public_lifecycle.PublicLifecycleTests.test_blocked_keyboard_handler_closes_only_its_owned_page test_public_lifecycle.PublicLifecycleTests.test_context_close_cancels_page_keyboard_and_preserves_browser -v
