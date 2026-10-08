#!/usr/bin/env bash
set -euo pipefail
mkdir -p /workspace /output
tar -C /source --exclude=.git --exclude=.tools --exclude=.cache --exclude=node_modules --exclude=target --exclude='packages/*/dist' --exclude=test-results --exclude=benchmarks/results --exclude=compatibility/evidence -cf - . | tar -C /workspace -xf -
cd /workspace
cp /source/.cache/portable-runtime-source-manifest.json /output/sources.json
python3 - <<'PY'
import hashlib,json
from pathlib import Path
for name,expected in json.loads(Path('/output/sources.json').read_text()).items():
 assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==expected,name
PY
cargo build --workspace --release --locked
cp target/release/flashwright-driver /output/flashwright-driver-linux-x64
rustc -vV > /output/rust.txt
ldd --version > /output/libc.txt
cc --version > /output/linker.txt
readelf --version-info /output/flashwright-driver-linux-x64 > /output/elf-versions.txt
readelf --dynamic /output/flashwright-driver-linux-x64 > /output/elf-dependencies.txt
python3 - <<'PY'
from pathlib import Path
import hashlib,json,struct,subprocess,threading
binary=Path('/output/flashwright-driver-linux-x64')
process=subprocess.Popen([str(binary)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
timer=threading.Timer(15,process.kill);timer.start()
try:
 handshake={'packageVersion':'0.0.0','protocolVersion':5,'capabilityInventoryVersion':1,'limits':{'controlFrameBytes':8388608,'pendingOperations':1024,'queuedMessages':128,'valueDepth':64,'valueNodes':100000,'binaryAttachmentBytes':33554432,'pendingAttachments':2}}
 message=json.dumps({'kind':'handshake','handshake':handshake}).encode()
 process.stdin.write(struct.pack('<I',len(message))+message);process.stdin.flush()
 length=struct.unpack('<I',process.stdout.read(4))[0];assert 0<length<=8388608
 response=json.loads(process.stdout.read(length));assert response['kind']=='handshake' and response['handshake']==handshake
 digest=hashlib.sha256()
 root=Path('packages/resident-runtime')
 for name in (root/'sources.txt').read_text().splitlines():
  data=(root/name).read_bytes();digest.update(struct.pack('<Q',len(data)));digest.update(data)
 assert response['residentRuntimeSha256']==digest.hexdigest()
 process.stdin.close();assert process.wait(timeout=5)==0
 (Path('/output')/'handshake.json').write_text(json.dumps(response,indent=2)+'\n')
finally:
 timer.cancel()
 if process.poll() is None:process.kill();process.wait()
 Path('/output/driver-stderr.txt').write_bytes(process.stderr.read())
for name,expected in json.loads(Path('/output/sources.json').read_text()).items():
 assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==expected,name
Path('/output/binary-sha256.txt').write_text(hashlib.sha256(binary.read_bytes()).hexdigest()+'\n')
PY
