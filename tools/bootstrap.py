#!/usr/bin/env python3
"""Install a pinned, checksum-verified Node toolchain inside this checkout."""

import argparse
import hashlib
import io
import json
import platform
from pathlib import Path
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent.parent


def download(url):
    return subprocess.run(
        ["curl", "--fail", "--silent", "--show-error", "--location", "--max-time", "120", url],
        check=True, capture_output=True,
    ).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", default="24.15.0", choices=["22.22.0", "24.15.0"])
    arguments = parser.parse_args()
    system = {"Darwin": "darwin", "Linux": "linux"}.get(platform.system())
    architecture = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64"}.get(platform.machine())
    if system is None or architecture is None:
        raise SystemExit("Bootstrap supports Linux and macOS on arm64/x64.")
    distribution = f"node-v{arguments.version}-{system}-{architecture}"
    destination = ROOT / ".tools" / distribution
    if not destination.exists():
        base_url = f"https://nodejs.org/dist/v{arguments.version}/"
        archive_name = distribution + ".tar.gz"
        checksums = download(base_url + "SHASUMS256.txt").decode()
        expected = next(line.split()[0] for line in checksums.splitlines() if line.endswith("  " + archive_name))
        archive = download(base_url + archive_name)
        actual = hashlib.sha256(archive).hexdigest()
        if expected != actual:
            raise SystemExit("Node archive checksum mismatch.")
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as source:
            source.extractall(destination.parent, filter="data")
        (destination / "flashwright-provenance.json").write_text(json.dumps({
            "url": base_url + archive_name, "sha256": actual,
            "checksumSource": base_url + "SHASUMS256.txt",
        }, indent=2) + "\n")
    print(destination / "bin")


if __name__ == "__main__":
    main()
