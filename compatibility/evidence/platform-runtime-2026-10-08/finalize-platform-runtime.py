from pathlib import Path
import datetime
import hashlib
import json
import shutil
import subprocess
import tarfile

root = Path.cwd()
archive = Path('compatibility/evidence/platform-runtime-2026-10-08')
checkpoint_path = Path('compatibility/evidence/platform-runtime-checkpoint-2026-10-08.json')
assert not checkpoint_path.exists()
read = lambda path: json.loads(Path(path).read_text())
hash_bytes = lambda data: hashlib.sha256(data).hexdigest()
hash_file = lambda path: hash_bytes(Path(path).read_bytes())
write = lambda path, value: Path(path).write_text(json.dumps(value, indent=2) + '\n')
portable = Path('.cache/linux-platform-runtime-portable-059')
portable_report = read(portable / 'evidence/platform-runtime-portable-linux/report.json')
assert portable_report['status'] == 'passed'
container_audit = read(portable / 'container-audit.json')
assert not container_audit['remainingProfiles'] and container_audit['hostExitCode'] == 0
shutil.copytree(portable, archive / portable.name, ignore=shutil.ignore_patterns('flashwright-driver-linux-x64'))
node = root / '.tools/node-v24.15.0-darwin-arm64/bin/node'
sources = json.loads(subprocess.check_output([str(node), '--input-type=module', '-e', "import {sourceManifest} from './tools/source-manifest.mjs'; console.log(JSON.stringify(await sourceManifest()))"], text=True))
assert len(sources) == 213
reports = [
 Path('compatibility/evidence/core-darwin-arm64-24.15.0-2026-10-08T21-31-20.036Z/report.json'),
 archive / 'platform-runtime-platforms-001/node22-full-chromium/report.json',
 archive / portable.name / 'evidence/platform-runtime-portable-linux/report.json',
 archive / 'linux-platform-runtime-057/evidence/platform-runtime-linux/report.json',
]
verified_reports = []
for report_path in reports:
 report = read(report_path)
 assert report['status'] == 'passed' and report['sources'] == sources, str(report_path)
 for field in ['sourceChangedDuringVerification', 'browserChangedDuringVerification', 'driverChangedDuringVerification']:
  assert not report.get(field, False), field
 for check in report['checks']:
  assert check['code'] == 0, check
  assert hash_file(report_path.parent / check['log']) == check.get('logSha256', check.get('sha256')), str(report_path)
 verified_reports.append({'path': str(report_path), 'sha256': hash_file(report_path), 'groups': len(report['checks']), 'node': report['node'], 'platform': report['platform'], 'driverSha256': report['driverSha256'], 'browser': report['browser'], 'environmentClass': report['environmentClass']})
assert [entry['groups'] for entry in verified_reports] == [36, 7, 10, 10]
package_reports = sorted(Path('compatibility/evidence').glob('platform-runtime-darwin-*/report.json'))
package_reports += sorted((archive / 'linux-platform-runtime-057/evidence').glob('platform-runtime-linux-x64-*/report.json'))
package_reports += sorted((archive / portable.name / 'evidence').glob('platform-runtime-linux-x64-*/report.json'))
assert len(package_reports) == 5
packages = []
for report_path in package_reports:
 report = read(report_path)
 assert report['status'] == 'passed' and report['sources'] == sources
 directory = report_path.parent
 runtime = read(directory / 'runtime.json')
 assert runtime == report['runtimeManifest']
 assert hash_file(directory / 'driver-runtime.tgz') == report['runtimeArchiveSha256']
 consumer_paths = list(directory.glob('packed-library-*.json')); assert len(consumer_paths) == 1
 consumer = read(consumer_paths[0])
 assert consumer['runtimeOverride'] is None
 assert consumer['driverSha256'] == runtime['executableSha256'] == report['driverSha256']
 assert hash_file(directory / 'library.tgz') == consumer['archiveSha256']
 with tarfile.open(directory / 'driver-runtime.tgz', 'r:gz') as bundle:
  names = bundle.getnames()
  assert len(names) == len(set(names))
  package = json.load(bundle.extractfile('package/package.json'))
  assert package['name'] == runtime['packageName'] and package['private'] is True and not package.get('scripts')
  assert json.load(bundle.extractfile('package/runtime.json')) == runtime
  provenance = json.load(bundle.extractfile('package/provenance.json'))
  assert provenance == read(directory / 'runtime-provenance.json') and provenance['sources'] == sources
  executable = bundle.getmember('package/bin/flashwright-driver')
  assert executable.isfile() and executable.mode & 0o111 and executable.size == runtime['executableBytes']
  assert hash_bytes(bundle.extractfile(executable).read()) == runtime['executableSha256']
  assert 'package/licenses/playwright/LICENSE.playwright' in names
  assert 'package/licenses/playwright/NOTICE.playwright' in names
  assert 'package/licenses/rust-standard-library/COPYRIGHT-library.html' in names
  for dependency in provenance['dependencies']:
   assert any(name.startswith('package/' + dependency['directory'] + '/') for name in names)
 with tarfile.open(directory / 'library.tgz', 'r:gz') as bundle:
  library = json.load(bundle.extractfile('package/package.json'))
  assert library['optionalDependencies'][runtime['packageName']] == runtime['packageVersion']
 cases = read(directory / 'runtime-package-checks.json')
 assert cases['status'] == 'passed' and len(cases['checks']) == (25 if report['platform'] == 'linux' else 23)
 packages.append({'report': str(report_path), 'reportSha256': hash_file(report_path), 'archive': str(directory / 'driver-runtime.tgz'), 'archiveSha256': report['runtimeArchiveSha256'], 'libraryArchive': str(directory / 'library.tgz'), 'libraryArchiveSha256': consumer['archiveSha256'], 'manifest': runtime, 'packageCases': len(cases['checks']), 'node': report['node']})
selected_packages = [entry for entry in packages if '21-34-58.501Z' in entry['report'] or portable.name in entry['report']]
assert len(selected_packages) == 2
assert selected_packages[1]['manifest']['minimumGlibcVersion'] == '2.30'
assert selected_packages[1]['manifest']['executableSha256'] == 'b6a08333d12871df394ed364bbff2892954eb1efd49113009c37a556fd562ba2'
# Preserve overwritten convenience reports, then restore their historical tracked bytes.
changed = subprocess.check_output(['git', 'diff', '--name-only', '--', 'compatibility/evidence'], text=True).splitlines()
canonical = archive / 'canonical-report-snapshot'
canonical.mkdir()
for name in changed:
 path = Path(name)
 assert path.parent == Path('compatibility/evidence') and path.suffix == '.json', name
 shutil.copy2(path, canonical / path.name)
 path.write_bytes(subprocess.check_output(['git', 'show', 'HEAD:' + name]))
cleanup = {'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'containers': {}}
for name in ['linux-platform-runtime-057', 'portable-linux-runtime-058', portable.name]:
 cleanup['containers'][name] = read(archive / name / 'container-audit.json')
 assert cleanup['containers'][name]['state']['Status'] == 'exited'
 assert not cleanup['containers'][name].get('remainingProfiles', [])
processes = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,comm=,args='], text=True)
owned = [line for line in processes.splitlines() if ('flashwright-driver' in line.split(maxsplit=3)[2] or ('chrome' in line.split(maxsplit=3)[2].lower() and '--user-data-dir=' in line and 'flashwright-chromium-' in line))]
cleanup['ownedDriverOrBrowserProcesses'] = owned
assert not owned, owned
containers = subprocess.check_output(['docker', '--context', 'desktop-linux', 'ps', '--format', '{{.Names}}'], text=True).splitlines()
cleanup['runningOwnedContainers'] = [name for name in containers if name.startswith('flashwright-')]
assert not cleanup['runningOwnedContainers'], cleanup
write(archive / 'final-cleanup.json', cleanup)
write(archive / 'package-artifact-audit.json', {'status': 'passed', 'packages': packages, 'checks': ['report and source identity', 'command log checksums', 'runtime and library tarball checksums', 'archive metadata and actual executable hash/size/mode', 'notices and provenance', 'exact library optional dependency', '23 macOS or 25 Linux package cases']})
checkpoint = {
 'schemaVersion': 1, 'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'status': 'passed-development-packaging', 'sources': sources,
 'summary': 'Automatic exact-version platform driver selection and integrity validation pass with real private npm tarballs, no install scripts, no driver override and no Cargo on the clean consumer PATH.',
 'verification': verified_reports, 'selectedMatrixGroups': 53, 'additionalInitialLinuxGroups': 10,
 'selectedPackages': selected_packages, 'allPackageArtifacts': str(archive / 'package-artifact-audit.json'),
 'portableLinux': {'builderImage': 'docker.io/library/rust@sha256:58643a517df55089a44540d827eb9bfd8d5f121c249767be6e25f24b68c0563d', 'evidence': str(archive / 'portable-linux-runtime-058'), 'buildGlibc': '2.31', 'actualRequiredGlibcSymbols': '2.30', 'loaderHandshake': 'passed on build image glibc 2.31', 'functionalBrowserEnvironment': 'Noble with Linux amd64 emulation on macOS arm64', 'supersededArtifact': 'Initial Noble-linked binary required glibc 2.39; its ten passing groups and tarball are retained separately.'},
 'provenancePolicy': 'Runtime provenance records the packaging workspace. Separate build records and conformance reports bind the actual executable; a matching handshake alone is not proof that an arbitrary input executable was built from that source snapshot.',
 'cleanup': str(archive / 'final-cleanup.json'),
 'limitations': ['Private provisional package names; registry absence does not establish scope ownership or publishing permission.', 'Consumers explicitly install two local tarballs; registry-backed acquisition remains unverified.', 'pnpm, Yarn, workspace and alias installation matrix remains open.', 'No new timing or fastest claim; earlier performance snapshots do not verify the new packaged resolution path.', 'Linux checks are emulated functional evidence. Native Linux performance and release support remain open.', 'The glibc 2.30 symbol floor is measured from ELF; loader handshake was tested on 2.31, and full browser tests on Noble. Broader older-distribution browser compatibility is not established.', 'M1 broader launch ownership, negotiated limits and unsupported-API coverage remain open.'],
 'archive': str(archive), 'canonicalReportsPreservedAndRestored': changed,
}
checkpoint['archiveFiles'] = {str(path.relative_to(archive)): hash_file(path) for path in sorted(archive.rglob('*')) if path.is_file()}
write(checkpoint_path, checkpoint)
print(json.dumps({'checkpoint': str(checkpoint_path), 'groups': 53, 'sources': len(sources), 'selectedPackages': [entry['archive'] for entry in selected_packages], 'archiveFiles': len(checkpoint['archiveFiles'])}, indent=2))
