#!/usr/bin/env bash
set -euo pipefail

mkdir -p /workspace /output
tar -C /source --exclude=.git --exclude=.tools --exclude=.cache --exclude=node_modules --exclude=target --exclude='packages/*/dist' --exclude=test-results --exclude=benchmarks/results --exclude=compatibility/evidence -cf - . | tar -C /workspace -xf -
cd /workspace
mkdir -p .cache compatibility/evidence
if ! command -v cc >/dev/null; then
  apt-get update
  apt-get install -y --no-install-recommends build-essential
fi
curl --fail --silent --show-error --location --max-time 120 https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init -o .cache/rustup-init
curl --fail --silent --show-error --location --max-time 120 https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init.sha256 -o .cache/rustup-init.sha256
(cd .cache && sha256sum --check rustup-init.sha256)
chmod +x .cache/rustup-init
.cache/rustup-init -y --no-modify-path --default-toolchain 1.98.0 --profile minimal --component rustfmt --component clippy
export PATH="$HOME/.cargo/bin:$PATH"
archive_results() {
  mkdir -p /output/evidence
  if [ -d compatibility/evidence ]; then cp -R compatibility/evidence/. /output/evidence/; fi
  if [ -f target/debug/flashwright-driver ]; then
    cp target/debug/flashwright-driver /output/flashwright-driver-linux-x64
    sha256sum /output/flashwright-driver-linux-x64 > /output/driver-sha256.txt
  fi
  rustc --version > /output/rust-version.txt
}
trap archive_results EXIT
npm ci --ignore-scripts --no-audit --no-fund
npm run verify:core
