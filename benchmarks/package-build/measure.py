"""Compare complete package builds with isolated outputs and shared installed dependencies."""

import argparse
import hashlib
import json
import os
import pathlib
import platform
import shutil
import signal
import statistics
import subprocess
import time


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', type=pathlib.Path)
parser.add_argument('--runtime', default='bun')
parser.add_argument('--baseline-ref', default='0afdbd361fba82eade9e7da588afdea381953ae3')
arguments = parser.parse_args()
repository = pathlib.Path(__file__).resolve().parents[2]
directory = arguments.output.resolve()
directory.mkdir(parents=True, exist_ok=True)
assert not (directory / 'observations.json').exists(), 'Choose a fresh result directory'
packages = ['flashwright-core', 'flashwright-runner', 'flashwright', 'flashwright-test']
order = ['baseline', 'candidate', 'candidate', 'baseline', 'baseline', 'candidate', 'candidate', 'baseline']
contract = {
    'baseline': f'Original full package builder at {arguments.baseline_ref}; current package sources in both arms',
    'candidate': 'Current builder with verified complete-package reuse',
    'workloads': ['unchanged', 'core-implementation-edit', 'runner-implementation-edit'],
    'order': order,
    'samplesPerConditionAndWorkload': 4,
    'acceptance': 'At least 25% lower median complete build elapsed time in each warmed workload, exact package bytes equal, functional controls pass. Cache creation retained separately.',
    'timer': 'time.monotonic around the complete runtime subprocess; edits and hashing outside timer.',
    'storage': 'One package fixture per condition with shared dependency symlinks; no Cargo or browser artifacts copied.',
    'runtime': arguments.runtime,
    'runtimeVersion': subprocess.check_output([arguments.runtime, '--version'], text=True).strip(),
    'compilerVersion': json.loads((repository / 'node_modules/typescript/package.json').read_text())['version'],
    'host': {'system': platform.system(), 'release': platform.release(), 'architecture': platform.machine(),
             'logicalCpus': os.cpu_count(),
             'model': subprocess.check_output(['sysctl', '-n', 'hw.model'], text=True).strip() if platform.system() == 'Darwin' else None},
    'controllerSha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
    'nativeLinuxVerified': False,
}


def save(name, value):
    (directory / name).write_text(json.dumps(value, indent=2) + '\n')


def hashes(root):
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob('*')) if path.is_file()
    }


def prepare_fixture(condition):
    fixture = directory / condition
    fixture.mkdir(exist_ok=False)
    paths = ['package.json', 'tsconfig.json', 'compatibility/upstream']
    paths += ['packages/' + name for name in packages + ['resident-runtime']]
    paths += ['tools/build-packages.mjs', 'tools/build-runner-runtime.mjs', 'tools/incremental-package-build.mjs', 'tools/package-compiler.mjs']
    for name in paths:
        source = repository / name
        destination = fixture / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            shutil.copytree(source, destination, ignore=shutil.ignore_patterns('node_modules', 'dist'))
        else:
            shutil.copyfile(source, destination)
    (fixture / 'node_modules/@flashwright').mkdir(parents=True)
    for source in (repository / 'node_modules').iterdir():
        if source.name not in ['@flashwright', 'flashwright']:
            (fixture / 'node_modules' / source.name).symlink_to(source.resolve())
    for name, target in {
        '@flashwright/core': 'flashwright-core', '@flashwright/runner': 'flashwright-runner',
        '@flashwright/test': 'flashwright-test', 'flashwright': 'flashwright',
    }.items():
        (fixture / 'node_modules' / name).symlink_to(fixture / 'packages' / target)
    if condition == 'baseline':
        original = subprocess.check_output(
            ['git', 'show', arguments.baseline_ref + ':tools/build-packages.mjs'], cwd=repository)
        (fixture / 'tools/build-packages.mjs').write_bytes(original)
    return fixture


save('contract.json', contract)
fixtures = {condition: prepare_fixture(condition) for condition in ['baseline', 'candidate']}
save('input-hashes.json', {
    condition: {**{name: hashes(fixture / name) for name in ['packages', 'tools', 'compatibility']},
                'rootFiles': {name: hashlib.sha256((fixture / name).read_bytes()).hexdigest()
                              for name in ['package.json', 'tsconfig.json']}}
    for condition, fixture in fixtures.items()
})
observations = []


def measure(condition, label, workload, warmup=False):
    load_before = os.getloadavg()
    failure = None
    started = time.monotonic()
    with (directory / (label + '.log')).open('wb') as log:
        process = subprocess.Popen([arguments.runtime, 'tools/build-packages.mjs'], cwd=fixtures[condition],
                                   stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            exit_code = process.wait(timeout=180)
        except BaseException as error:
            failure = error
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            exit_code = process.wait()
    observation = {
        'label': label, 'condition': condition, 'workload': workload, 'warmup': warmup,
        'seconds': time.monotonic() - started, 'exitCode': exit_code,
        'hostLoadAverageBefore': load_before, 'hostLoadAverageAfter': os.getloadavg(),
        'failure': type(failure).__name__ if failure else None,
    }
    observations.append(observation)
    save('observations.json', observations)
    print(json.dumps(observation), flush=True)
    if failure:
        raise failure
    assert exit_code == 0, f'Build failed: {label}'
    inventory = {name: hashes(fixtures[condition] / 'packages' / name / 'dist') for name in packages}
    save(label + '-outputs.json', inventory)
    return inventory


warmups = [measure(condition, 'warmup-' + condition, 'cache-creation', True) for condition in fixtures]
assert warmups[0] == warmups[1], 'Initial package outputs differ'
edits = {
    'core-implementation-edit': ('flashwright-core', 'errors.ts', 'maximumCommandStackCharacters', 'maximumRecordedStackCharacters'),
    'runner-implementation-edit': ('flashwright-runner', 'matchers.ts', 'isPageAssertion', 'usesPageAssertion'),
}
original_edit_sources = {
    workload: (fixtures['baseline'] / 'packages' / package / 'src' / filename).read_text()
    for workload, (package, filename, _, _) in edits.items()
}
for workload in contract['workloads']:
    counts = {condition: 0 for condition in fixtures}
    paired_outputs = {}
    for index, condition in enumerate(order):
        counts[condition] += 1
        sample = counts[condition]
        if workload in edits:
            package, filename, original_name, replacement_name = edits[workload]
            source = original_edit_sources[workload]
            assert original_name in source, 'Update the declared edit after a source refactor'
            if sample % 2:
                source = source.replace(original_name, replacement_name)
            (fixtures[condition] / 'packages' / package / 'src' / filename).write_text(source)
        inventory = measure(condition, f'{workload}-{index + 1:02}-{condition}', workload)
        if sample in paired_outputs:
            assert inventory == paired_outputs[sample], f'Package mismatch: {workload} sample {sample}'
        else:
            paired_outputs[sample] = inventory

results = {}
for workload in contract['workloads']:
    samples = {
        condition: [row['seconds'] for row in observations
                    if row['workload'] == workload and row['condition'] == condition]
        for condition in fixtures
    }
    medians = {condition: statistics.median(values) for condition, values in samples.items()}
    results[workload] = {
        'samples': samples, 'medianSeconds': medians,
        'reductionPercent': 100 * (1 - medians['candidate'] / medians['baseline']),
        'observedMaximumSeconds': {condition: max(values) for condition, values in samples.items()},
    }
save('results.json', results)
save('decision.json', {'accepted': all(result['reductionPercent'] >= 25 for result in results.values()),
                       'packageByteComparisonsPassed': 13, 'functionalAdmissionRequired': True})
print(json.dumps(results, indent=2), flush=True)
