// Adapted from Playwright 1.60.0, Apache-2.0; see compatibility/upstream/page-error-provenance.json.
import { failure } from './errors.js';

interface ExceptionDetails {
  text: string;
  exception?: {
    description?: string;
    value?: unknown;
    preview?: { properties: { name: string; value?: string }[] };
  };
  stackTrace?: { callFrames: { url: string; lineNumber: number; columnNumber: number; functionName: string }[] };
}

/** Preserve Chromium's error formatting without running code in the failing document. */
export function pageError(parameters: unknown): Error {
  if (!parameters || typeof parameters !== 'object' || !('exceptionJson' in parameters) || typeof parameters.exceptionJson !== 'string') {
    throw failure('ProtocolError', 'page.pageerror', 'driver omitted the Chromium exception payload');
  }
  let details: ExceptionDetails;
  try {
    const event = JSON.parse(parameters.exceptionJson);
    details = event.exceptionDetails;
    if (!details || typeof details.text !== 'string') throw new Error('missing exception details');
  } catch {
    throw failure('ProtocolError', 'page.pageerror', 'driver sent an invalid Chromium exception payload');
  }
  let description: string;
  if (details.exception) description = details.exception.description || String(details.exception.value);
  else {
    description = details.text;
    for (const frame of details.stackTrace?.callFrames ?? []) {
      description += `\n    at ${frame.functionName || '<anonymous>'} (${frame.url}:${frame.lineNumber}:${frame.columnNumber})`;
    }
  }
  const lines = description.split('\n');
  const stackStart = lines.findIndex(line => line.startsWith('    at'));
  const messageWithName = stackStart === -1 ? description : lines.slice(0, stackStart).join('\n');
  const separator = messageWithName.indexOf(':');
  const message = separator !== -1 && separator + 2 <= messageWithName.length ? messageWithName.substring(separator + 2) : messageWithName;
  const error = new Error(message);
  error.stack = stackStart === -1 ? '' : description;
  const nameOverride = details.exception?.preview?.properties.find(property => property.name === 'name');
  error.name = nameOverride ? nameOverride.value ?? 'Error' : separator === -1 ? '' : messageWithName.slice(0, separator);
  return error;
}
