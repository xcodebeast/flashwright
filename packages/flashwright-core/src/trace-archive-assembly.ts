import { failure } from './errors.js';
import { SealedTraceArchive, validateTraceArchiveManifest, traceArchiveDescriptorBytes, type TraceArchiveEntry, type TraceArchiveReader } from './trace-archive.js';

interface ArchiveInput { archive: SealedTraceArchive; reader: TraceArchiveReader }
const maximumArchives = 1024;
const maximumRetainedEntries = 32768;
const maximumRetainedBytes = 1024 * 1024 * 1024;
const maximumRetainedDescriptorBytes = 16 * 1024 * 1024;

/** Assemble leased manifests without making intermediate ZIPs or buffering resource payloads. */
export class TraceArchiveAssembly {
  private readonly inputs: ArchiveInput[] = [];
  private entries = new Map<string, TraceArchiveEntry>();
  private retainedEntries = 0;
  private retainedBytes = 0;
  private retainedDescriptorBytes = 0;
  private runnerAdded = false;
  private closed = false;
  private transferred = false;
  private disposal: Promise<void> | undefined;

  /** Success takes archive custody; rejection releases the reader and leaves custody with the caller. */
  addLibrary(archive: SealedTraceArchive): void { this.add(archive, false); }

  /** The runner journal is last, so its source aliases have the pinned merge precedence. */
  addRunner(archive: SealedTraceArchive): void { this.add(archive, true); }

  private add(archive: SealedTraceArchive, runner: boolean): void {
    if (this.closed) throw failure('TargetClosedError', 'tracing.assembly', 'archive assembly is closed');
    if (this.runnerAdded) throw failure('InvalidArgumentError', 'tracing.assembly', 'the runner archive must be the final input');
    if (this.inputs.length >= maximumArchives) throw failure('ResourceLimitError', 'tracing.assembly', 'assembly exceeds 1024 input archives');
    if (this.inputs.some(input => input.archive === archive)) throw failure('InvalidArgumentError', 'tracing.assembly', 'archive has already been admitted');
    const reader = archive.acquire();
    try {
      const retainedEntries = this.retainedEntries + reader.entries.length;
      const retainedBytes = this.retainedBytes + reader.entries.reduce((total, entry) => total + entry.byteLength, 0);
      const retainedDescriptorBytes = this.retainedDescriptorBytes + reader.entries.reduce((total, entry) => total + traceArchiveDescriptorBytes(entry), 0);
      if (retainedEntries > maximumRetainedEntries || retainedBytes > maximumRetainedBytes || retainedDescriptorBytes > maximumRetainedDescriptorBytes) {
        throw failure('ResourceLimitError', 'tracing.assembly', 'retained archive metadata or source bytes exceed the assembly limit');
      }
      const entries = new Map(this.entries);
      let hasTrace = false;
      for (const entry of reader.entries) {
        let name = entry.name;
        if (name.startsWith('resources/')) {
          const previous = entries.get(name);
          // Path-derived source aliases select the latest captured bytes, as in the pinned merge.
          if (previous && !name.startsWith('resources/src@') &&
              (previous.byteLength !== entry.byteLength || previous.contentHash !== entry.contentHash)) {
            throw failure('ProtocolError', 'tracing.assembly', 'content-addressed resource has conflicting bytes');
          }
        } else if (runner && name === 'test.trace') {
          hasTrace = true;
        } else if (!runner && /^trace\.(?:trace|network|stacks)$/.test(name)) {
          hasTrace ||= name === 'trace.trace';
          name = `${this.inputs.length}-${name}`;
        } else {
          throw failure('ProtocolError', 'tracing.assembly', 'input contains a stream outside its original archive role');
        }
        entries.set(name, Object.freeze({ ...entry, name }));
      }
      if (!hasTrace) throw failure('ProtocolError', 'tracing.assembly', 'input has no original trace stream');
      validateTraceArchiveManifest([...entries.values()]);
      this.inputs.push({ archive, reader });
      this.entries = entries;
      this.retainedEntries = retainedEntries;
      this.retainedBytes = retainedBytes;
      this.retainedDescriptorBytes = retainedDescriptorBytes;
      this.runnerAdded = runner;
    } catch (error) { reader.release(); throw error; }
  }

  /** Transfer the complete manifest once; disposing this builder cannot delete transferred files. */
  seal(): SealedTraceArchive {
    if (this.closed) throw failure('TargetClosedError', 'tracing.assembly', 'archive assembly is closed');
    if (!this.inputs.length) throw failure('InvalidArgumentError', 'tracing.assembly', 'archive assembly has no inputs');
    const inputs = [...this.inputs];
    const archive = new SealedTraceArchive([...this.entries.values()], () => disposeInputs(inputs));
    this.closed = true;
    this.transferred = true;
    this.clear();
    return archive;
  }

  dispose(): Promise<void> {
    this.closed = true;
    this.disposal ??= this.transferred ? Promise.resolve() : disposeInputs([...this.inputs]).finally(() => this.clear());
    return this.disposal;
  }

  private clear(): void {
    this.inputs.length = 0;
    this.entries.clear();
    this.retainedBytes = 0;
    this.retainedDescriptorBytes = 0;
    this.retainedEntries = 0;
  }
}

/** Release every reader before cleanup; shared recording stores must never wait on our next input. */
async function disposeInputs(inputs: readonly ArchiveInput[]): Promise<void> {
  for (const input of inputs) input.reader.release();
  const failures: { index: number; error: unknown }[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= inputs.length) return;
      try { await inputs[index]!.archive.dispose(); }
      catch (error) { failures.push({ index, error }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, inputs.length) }, worker));
  failures.sort((left, right) => left.index - right.index);
  if (failures.length) throw failures[0]!.error;
}
