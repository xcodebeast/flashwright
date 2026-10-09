import { getCallSites } from 'node:util';
import { fileURLToPath } from 'node:url';
import { failure } from './errors.js';

export interface CallerLocation { file: string; line: number; column: number; function: string }
export interface SourcePosition { source: string; line: number; column: number }
export type SourcePositionMapper = (position: SourcePosition) => SourcePosition;
let sourcePositionMapper: SourcePositionMapper | undefined;

/** The runner owns its transform maps; the library never modifies global stack formatting. */
export function installSourcePositionMapper(mapper: SourcePositionMapper): () => void {
  if (sourcePositionMapper) throw failure('ProtocolError', 'runner.integration', 'a caller source-position mapper is already installed');
  sourcePositionMapper = mapper;
  return () => { if (sourcePositionMapper === mapper) sourcePositionMapper = undefined; };
}

/** Capture structured locations without invoking application Error.prepareStackTrace hooks. */
export function callerLocations(): CallerLocation[] {
  const locations: CallerLocation[] = [];
  let encodedBytes = 2;
  for (const frame of getCallSites(64, { sourceMap: sourcePositionMapper === undefined })) {
    if (!frame.scriptName || frame.scriptName === '[unknown]' || frame.lineNumber < 1) continue;
    if (/[\\/]call-sites\.(?:js|ts)$/.test(frame.scriptName)) continue;
    const position = { source: frame.scriptName, line: frame.lineNumber, column: Math.max(0, frame.columnNumber - 1) };
    const mapped = sourcePositionMapper ? sourcePositionMapper(position) : position;
    let file = mapped.source;
    if (file.startsWith('file:')) {
      try { file = fileURLToPath(file); } catch { /* Keep an unrecognized location verbatim. */ }
    }
    const location = { file, line: mapped.line, column: frame.columnNumber > 0 ? mapped.column + 1 : 0, function: frame.functionName };
    encodedBytes += Buffer.byteLength(JSON.stringify(location)) + 1;
    if (encodedBytes > 16384) break;
    locations.push(location);
    if (locations.length === 32) break;
  }
  return locations;
}

export function callerStack(): string {
  return 'Error\n' + callerLocations().map(location => `    at ${location.function ? `${location.function} (` : ''}${location.file}:${location.line}:${location.column}${location.function ? ')' : ''}`).join('\n');
}
