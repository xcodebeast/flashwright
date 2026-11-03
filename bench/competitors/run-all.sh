#!/bin/sh
# Every published configuration: both layouts with 1 and 4 workers, 15 runs each.
# Usage: bench/competitors/run-all.sh [iterations]
set -e
cd "$(dirname "$0")/../.."
iterations=${1:-15}
node=${NODE_BIN:-node}
LAYOUT=grouped "$node" bench/competitors/run.mjs 1 "$iterations"
LAYOUT=grouped "$node" bench/competitors/run.mjs 4 "$iterations"
LAYOUT=files "$node" bench/competitors/run.mjs 1 "$iterations"
LAYOUT=files "$node" bench/competitors/run.mjs 4 "$iterations"
