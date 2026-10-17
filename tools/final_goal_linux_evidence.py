"""Reconstruct retained Linux observations without opening original capture paths.

The stdin bridge reads a bounded JSON header followed by four exact byte records.
It shares the existing parser and derivation; it never changes admission status.
"""

from pathlib import PurePosixPath
import sys

try:
    from . import linux_cgroup_resources as resources
except ImportError:
    import linux_cgroup_resources as resources

inputs = resources.inputs
require = resources.require
MAXIMUM_HEADER_BYTES = 16 * 1024
MAXIMUM_AGGREGATE_BYTES = 96 * 1024 * 1024
FILE_LIMITS = {'capture': inputs.MAXIMUM_SNAPSHOT_BYTES, 'before': inputs.MAXIMUM_SNAPSHOT_BYTES,
               'after': inputs.MAXIMUM_SNAPSHOT_BYTES, 'native': resources.MAXIMUM_NATIVE_BYTES}


def verify_header(header):
    require(isinstance(header, dict) and set(header) == {'schemaVersion', 'accountingClass', 'files'},
            'Invalid retained Linux evidence header')
    require(type(header['schemaVersion']) is int and header['schemaVersion'] == 1
            and header['accountingClass'] == resources.ACCOUNTING_CLASS, 'Wrong retained Linux accounting class')
    require(isinstance(header['files'], dict) and set(header['files']) == set(FILE_LIMITS),
            'Missing or unknown retained Linux original')
    total = 0
    for name, maximum in FILE_LIMITS.items():
        receipt = header['files'][name]
        require(isinstance(receipt, dict) and set(receipt) == {'bytes', 'sha256'}, 'Invalid retained content receipt')
        require(type(receipt['bytes']) is int and 0 < receipt['bytes'] <= maximum, 'Retained file byte limit exceeded')
        require(isinstance(receipt['sha256'], str) and inputs.HASH_PATTERN.fullmatch(receipt['sha256']),
                'Invalid retained content hash')
        total += receipt['bytes']
    require(total <= MAXIMUM_AGGREGATE_BYTES, 'Retained aggregate byte limit exceeded')


def reconstruct(header, originals):
    verify_header(header)
    require(isinstance(originals, dict) and set(originals) == set(FILE_LIMITS), 'Missing or unknown original bytes')
    # Check every supplied size/hash before parsing the first original.
    for name, receipt in header['files'].items():
        raw = originals[name]
        require(type(raw) is bytes and len(raw) == receipt['bytes']
                and inputs.digest(raw) == receipt['sha256'], 'Retained original bytes differ: ' + name)
    records = {name: inputs.decode(raw) for name, raw in originals.items()}
    require(all(isinstance(record, dict) for record in records.values()), 'Original records must be JSON objects')
    report = records['capture']
    original_directory = None
    for name, key in (('before', 'before'), ('after', 'after'), ('native', 'nativeReceipt')):
        receipt = report[key]
        require(isinstance(receipt, dict), 'Missing original member receipt')
        inputs.verify_receipt({key: receipt[key] for key in ('path', 'bytes', 'sha256')})
        path = PurePosixPath(receipt['path'])
        require(path.is_absolute() and str(path) == receipt['path'] and '\\' not in receipt['path']
                and path.name == name + '.json', 'Unexpected original member path')
        if original_directory is None:
            original_directory = path.parent
        require(path.parent == original_directory, 'Original members belong to different capture directories')
        require({key: receipt[key] for key in ('bytes', 'sha256')} == header['files'][name],
                'Original member receipt differs from retained bytes: ' + name)
    observed = resources.derive_observations(report, records['before'], records['after'], records['native'])
    observed['retainedOriginals'] = header['files']
    return observed


def read_stream(stream):
    header_bytes = stream.readline(MAXIMUM_HEADER_BYTES + 1)
    require(header_bytes.endswith(b'\n') and len(header_bytes) <= MAXIMUM_HEADER_BYTES, 'Invalid retained header framing')
    header = inputs.decode(header_bytes)
    verify_header(header)
    originals = {}
    for name in FILE_LIMITS:
        size = header['files'][name]['bytes']
        originals[name] = stream.read(size)
        require(len(originals[name]) == size, 'Truncated retained original: ' + name)
    require(stream.read(1) == b'', 'Trailing retained input')
    return reconstruct(header, originals)


def main():
    require(sys.argv[1:] == ['--stdin'], 'Usage: final_goal_linux_evidence.py --stdin')
    try:
        result = read_stream(sys.stdin.buffer)
    except (ValueError, KeyError, TypeError, StopIteration, RecursionError, OverflowError) as error:
        result = {'status': 'rejected', 'accountingClass': resources.ACCOUNTING_CLASS,
                  'resourceAdmission': False, 'performanceAccepted': False,
                  'error': {'type': type(error).__name__, 'message': str(error)}}
    sys.stdout.buffer.write(inputs.encode(result))
    return 0 if result['status'] == 'verified-local-observations' else 1


if __name__ == '__main__':
    sys.exit(main())
