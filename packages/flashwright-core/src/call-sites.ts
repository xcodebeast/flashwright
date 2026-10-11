import { getCallSites } from 'node:util';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failure } from './errors.js';

export interface CallerLocation { file: string; line: number; column: number; function: string }
export interface SourcePosition { source: string; line: number; column: number }
export type SourcePositionMapper = (position: SourcePosition) => SourcePosition;
let sourcePositionMapper: SourcePositionMapper | undefined;
const frameworkCallerDirectories = [resolve(__dirname)];
if (basename(__dirname) === 'commonjs' && basename(dirname(__dirname)) === 'dist')
  frameworkCallerDirectories.push(resolve(__dirname, '../../src'));

function frameworkOwnsCaller(file: string): boolean {
  return frameworkCallerDirectories.some(directory => {
    const path = relative(directory, file);
    return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  });
}

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
  // The runner maps its own transform output back to the original source.
  const mapper = sourcePositionMapper;
  for (const frame of getCallSites(64, { sourceMap: mapper === undefined })) {
    if (!frame.scriptName || frame.scriptName === '[unknown]' || frame.lineNumber < 1) continue;
    const position = { source: frame.scriptName, line: frame.lineNumber, column: Math.max(0, frame.columnNumber - 1) };
    const mapped = mapper ? mapper(position) : position;
    let file = mapped.source;
    if (file.startsWith('file:')) {
      try { file = fileURLToPath(file); } catch { /* Keep an unrecognized location verbatim. */ }
    }
    if (/[\\/]call-sites\.(?:js|ts)$/.test(file) && frameworkOwnsCaller(file)) continue;
    const location = { file, line: mapped.line, column: frame.columnNumber > 0 ? mapped.column + 1 : 0, function: frame.functionName };
    encodedBytes += Buffer.byteLength(JSON.stringify(location)) + 1;
    if (encodedBytes > 16384) break;
    locations.push(location);
    if (locations.length === 32) break;
  }
  return locations;
}

/** Keep the mapped caller ahead of this package's frames, retaining those frames for debugging. */
export function callerStack(): string {
  const locations = callerLocations();
  const callerFrames: string[] = [];
  const frameworkFrames: string[] = [];
  for (const location of locations) {
    const frame = `    at ${location.function ? `${location.function} (` : ''}${location.file}:${location.line}:${location.column}${location.function ? ')' : ''}`;
    (frameworkOwnsCaller(location.file) ? frameworkFrames : callerFrames).push(frame);
  }
  return 'Error\n' + callerFrames.join('\n') + (frameworkFrames.length ? '\nCaptured Flashwright frames:\n' + frameworkFrames.join('\n') : '');
}
