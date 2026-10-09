/** process.version is Bun's Node compatibility version, not its actual runtime identity. */
export const javascriptRuntime = Object.freeze({
  name: process.versions.bun ? 'bun' : 'node',
  version: process.versions.bun ?? process.versions.node,
});

export const runtimeMetadata = Object.freeze({
  runtime: javascriptRuntime,
  node: javascriptRuntime.name === 'node' ? process.version : null,
  ...(javascriptRuntime.name === 'bun' ? { nodeCompatibility: process.version } : {}),
});

// Retain historical Node filenames while giving Bun evidence an unambiguous namespace.
export const runtimeArtifactLabel = javascriptRuntime.name === 'bun'
  ? `bun-${javascriptRuntime.version}`
  : javascriptRuntime.version;

/** Accept historical Node-only reports, but never confuse Bun with its Node API version. */
export function reportRuntime(report) {
  if (report.runtime && ['node', 'bun'].includes(report.runtime.name) && typeof report.runtime.version === 'string') return report.runtime;
  if (typeof report.node === 'string' && /^v\d+\.\d+\.\d+$/.test(report.node)) return { name: 'node', version: report.node.slice(1) };
  throw new Error('Report lacks an explicit JavaScript runtime identity');
}
