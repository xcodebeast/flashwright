#!/usr/bin/env python3
"""Install checksum-verified Bun, or an explicit Node compatibility toolchain, locally."""

import argparse
import hashlib
import io
import json
import platform
from pathlib import Path
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def download(url):
    return subprocess.run(
        ["curl", "--fail", "--silent", "--show-error", "--location", "--max-time", "120", url],
        check=True, capture_output=True,
    ).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", default="bun", choices=["bun", "node"])
    parser.add_argument("--version")
    arguments = parser.parse_args()
    version = arguments.version or ("1.4.2" if arguments.runtime == "bun" else "24.15.0")
    if version not in ({"1.4.2"} if arguments.runtime == "bun" else {"22.22.0", "24.15.0"}):
        parser.error("Use Bun 1.4.2 or Node 22.22.0/24.15.0 with --runtime node")
    system = {"Darwin": "darwin", "Linux": "linux"}.get(platform.system())
    architecture = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64"}.get(platform.machine())
    if system is None or architecture is None:
        raise SystemExit("Bootstrap supports Linux and macOS on arm64/x64.")
    distribution = f"{arguments.runtime}-v{version}-{system}-{architecture}"
    destination = ROOT / ".tools" / distribution
    executable = destination / "bin" / arguments.runtime
    receipt = destination / "flashwright-provenance.json"
    if not executable.exists() or not receipt.exists():
        if arguments.runtime == "bun":
            archive_stem = f"bun-{system}-{'aarch64' if architecture == 'arm64' else 'x64'}"
            archive_name = archive_stem + ".zip"
            base_url = f"https://github.com/oven-sh/bun/releases/download/bun-v{version}/"
        else:
            archive_name = distribution + ".tar.gz"
            base_url = f"https://nodejs.org/dist/v{version}/"
        checksums = download(base_url + "SHASUMS256.txt").decode()
        expected = next(line.split()[0] for line in checksums.splitlines() if line.split()[-1] == archive_name)
        archive = download(base_url + archive_name)
        actual = hashlib.sha256(archive).hexdigest()
        if expected != actual:
            raise SystemExit(f"{arguments.runtime} archive checksum mismatch.")
        destination.parent.mkdir(parents=True, exist_ok=True)
        if arguments.runtime == "bun":
            executable.parent.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(io.BytesIO(archive)) as source:
                executable.write_bytes(source.read(archive_stem + "/bun"))
            executable.chmod(0o755)
        else:
            with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as source:
                source.extractall(destination.parent, filter="data")
        receipt.write_text(json.dumps({
            "url": base_url + archive_name, "sha256": actual,
            "checksumSource": base_url + "SHASUMS256.txt",
            "executableSha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
        }, indent=2) + "\n")
    provenance = json.loads(receipt.read_text())
    if "executableSha256" in provenance and hashlib.sha256(executable.read_bytes()).hexdigest() != provenance["executableSha256"]:
        raise SystemExit("Installed runtime checksum mismatch.")
    installed = subprocess.check_output([str(executable), "--version"], text=True).strip().removeprefix("v")
    if installed != version:
        raise SystemExit(f"Expected {arguments.runtime} {version}, found {installed}.")
    print(executable.parent)


if __name__ == "__main__":
    main()
