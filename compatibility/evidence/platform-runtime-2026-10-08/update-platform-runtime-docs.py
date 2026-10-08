from pathlib import Path
import json

checkpoint_path = 'compatibility/evidence/platform-runtime-checkpoint-2026-10-08.json'
checkpoint = json.loads(Path(checkpoint_path).read_text())
assert checkpoint['status'] == 'passed-development-packaging'
summary = 'Exact-version private platform packages now select the driver automatically, validate metadata and executable integrity before spawn, and preserve the ordinary launch budget. Clean offline npm ESM/CommonJS consumers run without install scripts, a driver override or Cargo. At 213 matching source hashes, 36 native macOS Node24 core groups, seven Node22/full-Chromium groups and ten emulated Linux groups pass; each platform runs the complete 82-case lifecycle suite. Package checks cover 23 macOS or 25 Linux cases, including corruption, unsupported libc, concurrent browsers and an expired lookup that cannot spawn. The selected Linux executable is built on glibc 2.31 and requires symbols through 2.30; its loader handshake passes on 2.31 and browser checks pass on Noble under emulation. The earlier glibc 2.39 artifact and its ten passing groups are retained separately. No publication, native Linux or packaged-startup performance claim.'
path = Path('compatibility/development-coverage.json')
coverage = json.loads(path.read_text())
coverage['capabilities']['chromium.launch'].append('automatic exact-version platform runtime selection with integrity, architecture and libc checks')
coverage['implementation']['platformRuntime'] = summary
coverage['implementation']['platformRuntimeEvidence'] = checkpoint_path
for name in ['packages/flashwright/src/engine-contract.ts', 'packages/flashwright/src/driver-runtime.ts', 'tools/pack-driver-runtime.mjs', 'tools/test-platform-runtime.mjs', 'compatibility/m1/runtime-package.mjs']:
 assert name not in coverage['testSources']; coverage['testSources'].append(name)
coverage['limitations'][0] = 'Platform packages are private local tarballs under provisional names; registry-backed acquisition and browser installation tooling remain open. The explicit development driver override remains available.'
for index, limitation in enumerate(coverage['limitations']):
 if limitation.startswith('Resident assertions remain opt-in.'):
  coverage['limitations'][index] = 'Resident assertions are now on by default, with FLASHWRIGHT_RESIDENT_ASSERTIONS=0 retaining the comparison path. Adoption and timing evidence remains bound to the recorded binaries and adapter snapshots in compatibility/evidence/resident-default-checkpoint-2026-10-08.json; the packaged resolution path has no new timing claim. The material complete-flow target, retained regressions, native Linux, contention and release gates remain open.'
path.write_text(json.dumps(coverage, indent=2) + '\n')
path = Path('compatibility/reference-manifest.json')
reference = json.loads(path.read_text())
reference['toolchains']['consumerPackageManagerStatus'] = 'npm packed ESM/CommonJS development consumers verified on macOS Node 22/24 and emulated Linux Node 24. Private local platform tarballs now select the driver automatically without Cargo or a driver override. pnpm/Yarn, aliases and registry acquisition remain open.'
engine = reference['engineDevelopment']
engine['evidence'].append(checkpoint_path)
engine['evidence'].extend(entry['path'] for entry in checkpoint['verification'][:3])
engine['consumerRuntimePolicy'] = 'Private exact-version macOS arm64/Linux x64 optional runtime packages are selected and verified automatically. Offline npm consumers explicitly install local library/runtime tarballs with scripts disabled and no Cargo or driver override. Registry publication/acquisition, pnpm, Yarn and aliases remain open.'
engine['sourceIdentity'] = 'The current platform-runtime tree has 213 source hashes and passes 53 selected matrix groups (36 native macOS Node24, seven Node22/full Chromium, ten emulated Linux). Production Rust and the macOS optimized driver remain unchanged at 233bb93b96581bf8dbf9d63f3222c017c9e8f8ec77f595a4ef534461e0f3c13c; the portable Linux binary is b6a08333d12871df394ed364bbff2892954eb1efd49113009c37a556fd562ba2. The library now resolves installed platform packages and includes resolution in the launch budget. Earlier timing claims remain bound to their prior adapter snapshots. See ' + checkpoint_path
engine['platformRuntimeStatus'] = summary
engine['platformRuntimeArtifacts'] = checkpoint['selectedPackages']
engine['performanceStatus'] = engine['performanceStatus'].replace('The rebuilt default comparison records', 'The historical rebuilt-default comparison records') + ' The current platform-package resolver and launch-budget changes have no new timing result.'
path.write_text(json.dumps(reference, indent=2) + '\n')
path = Path('compatibility/milestones.json')
milestones = json.loads(path.read_text())
first = next(item for item in milestones['milestones'] if item['id'] == 'M1')
first['completed'].append(summary)
first['evidence'].append(checkpoint_path)
assert first['remaining'][0].startswith('Packed platform runtime acquisition')
first['remaining'][0] = 'Published registry acquisition, finalized package names/scope ownership, pnpm/Yarn/workspace/alias matrix and explicit browser installation tooling; private local runtime selection now passes'
milestones['nextImplementation'] = 'Complete remaining M1 launch ownership, registry acquisition and package-manager/alias coverage, and M2 runner/artifact/frame/network semantics. Private platform tarballs now pass automatic selection and integrity checks; publication and browser installation remain open. Use the retained causal driver comparison for further performance changes: independent page initialization did not establish browser-flow benefit and was rejected. Resident assertions remain on by default. Native Linux performance needs a native x64 host; emulation remains functional-only. CBOR, contention, broader migration and release gates remain open.'
path.write_text(json.dumps(milestones, indent=2) + '\n')
path = Path('README.md')
readme = path.read_text()
needle = '[SPECS.md](SPECS.md) defines the implementation and release gates.'
paragraph = 'Private macOS arm64 and Linux x64 runtime packages now launch automatically after integrity checks. The [packaging checkpoint](' + checkpoint_path + ') records 53 passing verification groups across native macOS Node 22/24 and emulated Linux, including clean offline npm consumers without Cargo or a driver override. The selected Linux binary requires glibc 2.30 symbols and was loader-tested on 2.31. Names remain provisional and unpublished; this checkpoint makes no new speed claim. Earlier benchmark snapshots remain tied to their recorded adapters and binaries\n\n'
assert needle in readme
path.write_text(readme.replace(needle, paragraph + needle, 1))
print('Updated platform-runtime documentation and coverage')
