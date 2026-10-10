import { constants as filesystemConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { upstreamRequire } from './upstream-runtime.js';

const { parseErrorStack, stripAnsiEscapes } = upstreamRequire('playwright-core/lib/coreBundle').iso as {
  parseErrorStack(stack: string, separator: string): { location?: FailureContextLocation };
  stripAnsiEscapes(text: string): string;
};

export const maximumFailureContextBytes = 256 * 1024;
export const maximumFailureContextDiagnosticCharacters = 32768;
export const maximumFailureContextErrors = 16;
export const maximumFailureContextStackLines = 1024;
export const maximumFailureContextSourceBytes = 8 * 1024 * 1024;
export const maximumFailureContextSourceCharacters = 64 * 1024;
export const failureContextSourceReadBytes = 64 * 1024;
const sourceLinesAbove = 100;
const sourceLinesBelow = 100;
const truncationNotice = '\n\n[Failure context truncated: diagnostic size limit reached.]';
const fieldTruncationNotice = '\n[Diagnostic truncated: character limit reached.]';
const fixTestInstructions = `# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.
`;

export interface FailureContextLocation {
  file: string;
  line: number;
  column: number;
}

export interface FailureContextError {
  message?: string | undefined;
  stack?: string | undefined;
  errorContext?: string | undefined;
}

export interface FailureContextOptions {
  titlePath: string[];
  location: FailureContextLocation;
  errors: FailureContextError[];
  pageSnapshot?: string | undefined;
}

/** Retains at most the output byte allowance, reserving room for an explicit truncation notice. */
class BoundedMarkdown {
  private readonly fragments: string[] = [];
  private bytes = 0;
  truncated = false;

  append(text: string): void {
    if (this.truncated)
      return;
    const remainingBytes = maximumFailureContextBytes - Buffer.byteLength(truncationNotice) - this.bytes;
    const prefix = utf8Prefix(text, remainingBytes);
    this.fragments.push(prefix);
    this.bytes += Buffer.byteLength(prefix);
    this.truncated = prefix.length !== text.length;
  }

  finish(): string {
    if (this.truncated)
      this.fragments.push(truncationNotice);
    return this.fragments.join('');
  }
}

/** Slices before UTF-8 measurement so caller-owned oversized strings never become oversized scratch buffers. */
function utf8Prefix(text: string, maximumBytes: number): string {
  let end = Math.min(text.length, maximumBytes);
  let prefix = text.slice(0, end);
  if (Buffer.byteLength(prefix) > maximumBytes) {
    let start = 0;
    while (start < end) {
      const middle = Math.ceil((start + end) / 2);
      if (Buffer.byteLength(text.slice(0, middle)) <= maximumBytes)
        start = middle;
      else
        end = middle - 1;
    }
    end = start;
  }
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!))
    end--;
  prefix = text.slice(0, end);
  return prefix;
}

function diagnosticPrefix(text: string): string {
  const prefix = text.slice(0, maximumFailureContextDiagnosticCharacters);
  return prefix.length === text.length ? prefix : prefix + fieldTruncationNotice;
}

interface SourceWindow {
  lines: string[];
  start: number;
  end: number;
}

type SourceResult = SourceWindow | { omission: string } | undefined;

/** Reads bounded chunks, counts all lines, and retains only the source window; nonregular files cannot block open. */
async function readSourceWindow(location: FailureContextLocation): Promise<SourceResult> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(location.file, filesystemConstants.O_RDONLY | filesystemConstants.O_NONBLOCK);
    const information = await file.stat();
    if (!information.isFile())
      return undefined;
    if (information.size > maximumFailureContextSourceBytes)
      return { omission: `Test source omitted: file exceeds the ${maximumFailureContextSourceBytes}-byte source limit.` };
    const start = Math.max(0, location.line - sourceLinesAbove - 1);
    const requestedEnd = location.line + sourceLinesBelow;
    const lines: string[] = [];
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(failureContextSourceReadBytes);
    let sourceBytes = 0;
    let lineNumber = 0;
    let currentLine = '';
    let retainedCharacters = 0;
    let oversizedWindow = false;
    const consume = (text: string) => {
      let position = 0;
      while (position < text.length) {
        const newline = text.indexOf('\n', position);
        const end = newline === -1 ? text.length : newline;
        if (!oversizedWindow && lineNumber >= start && lineNumber < requestedEnd) {
          const characters = end - position;
          if (retainedCharacters + characters > maximumFailureContextSourceCharacters) {
            oversizedWindow = true;
            currentLine = '';
            lines.length = 0;
          } else {
            currentLine += text.slice(position, end);
            retainedCharacters += characters;
          }
        }
        if (newline === -1)
          break;
        if (!oversizedWindow && lineNumber >= start && lineNumber < requestedEnd)
          lines.push(currentLine);
        currentLine = '';
        lineNumber++;
        position = end + 1;
      }
    };
    while (true) {
      const length = Math.min(buffer.length, maximumFailureContextSourceBytes - sourceBytes + 1);
      const { bytesRead } = await file.read(buffer, 0, length, null);
      if (!bytesRead)
        break;
      sourceBytes += bytesRead;
      if (sourceBytes > maximumFailureContextSourceBytes)
        return { omission: `Test source omitted: file exceeds the ${maximumFailureContextSourceBytes}-byte source limit.` };
      consume(decoder.write(buffer.subarray(0, bytesRead)));
    }
    consume(decoder.end());
    if (oversizedWindow)
      return { omission: `Test source omitted: frame exceeds the ${maximumFailureContextSourceCharacters}-character source limit.` };
    if (lineNumber >= start && lineNumber < requestedEnd)
      lines.push(currentLine);
    return { lines, start, end: Math.min(lineNumber + 1, requestedEnd) };
  } catch {
    return undefined;
  } finally {
    await file?.close().catch(() => {});
  }
}

/** Preserves the pinned runner's ordinary Markdown; bounded diagnostics are explicitly marked when omitted or truncated. */
export async function buildFailureContext(options: FailureContextOptions): Promise<string | undefined> {
  let lastMeaningfulError: FailureContextError | undefined;
  for (const error of options.errors) {
    if (error.message)
      lastMeaningfulError = error;
  }
  if (!lastMeaningfulError && !options.pageSnapshot)
    return undefined;
  const markdown = new BoundedMarkdown();
  markdown.append(fixTestInstructions);
  markdown.append('\n# Test info\n\n- Name: ');
  for (let index = 0; index < options.titlePath.length && !markdown.truncated; index++) {
    if (index)
      markdown.append(' >> ');
    markdown.append(diagnosticPrefix(options.titlePath[index]!));
  }
  const filePath = diagnosticPrefix(options.location.file);
  const locationPath = isAbsolute(filePath) ? relative(process.cwd(), filePath) : filePath;
  markdown.append(`\n- Location: ${locationPath}:${options.location.line}:${options.location.column}`);
  if (lastMeaningfulError) {
    markdown.append('\n\n# Error details');
    let formattedErrors = 0;
    for (const error of options.errors) {
      if (markdown.truncated)
        break;
      if (!error.message)
        continue;
      if (formattedErrors === maximumFailureContextErrors) {
        markdown.append(`\n\n[Additional error details omitted: ${maximumFailureContextErrors}-error limit reached.]`);
        break;
      }
      formattedErrors++;
      markdown.append('\n\n```\n');
      markdown.append(stripAnsiEscapes(diagnosticPrefix(error.message)));
      markdown.append('\n```');
      if (error.errorContext) {
        markdown.append('\n\n```yaml\n');
        markdown.append(diagnosticPrefix(error.errorContext));
        markdown.append('\n```');
      }
    }
  }
  if (options.pageSnapshot && !markdown.truncated) {
    markdown.append('\n\n# Page snapshot\n\n```yaml\n');
    markdown.append(diagnosticPrefix(options.pageSnapshot));
    markdown.append('\n```');
  }
  if (lastMeaningfulError?.stack && !markdown.truncated)
    await appendSourceFrame(markdown, lastMeaningfulError);
  return markdown.finish();
}

async function appendSourceFrame(markdown: BoundedMarkdown, error: FailureContextError): Promise<void> {
  const stack = error.stack!;
  if (stack.length > maximumFailureContextDiagnosticCharacters) {
    markdown.append(`\n\nTest source omitted: stack exceeds the ${maximumFailureContextDiagnosticCharacters}-character limit.`);
    return;
  }
  let stackLines = 1;
  for (let index = 0; index < stack.length; index++) {
    if (stack[index] === '\n' && ++stackLines > maximumFailureContextStackLines) {
      markdown.append(`\n\nTest source omitted: stack exceeds the ${maximumFailureContextStackLines}-line limit.`);
      return;
    }
  }
  let location: FailureContextLocation | undefined;
  try {
    location = parseErrorStack(stack, sep).location;
  } catch {
    return;
  }
  if (!location || !Number.isSafeInteger(location.line) || location.line < 1 || !Number.isSafeInteger(location.column) || location.column < 0)
    return;
  if (location.column > maximumFailureContextSourceCharacters) {
    markdown.append(`\n\nTest source omitted: column exceeds the ${maximumFailureContextSourceCharacters}-character source limit.`);
    return;
  }
  const source = await readSourceWindow(location);
  if (!source)
    return;
  if ('omission' in source) {
    markdown.append('\n\n' + source.omission);
    return;
  }
  const width = String(source.end).length;
  const boundedMessage = stripAnsiEscapes(diagnosticPrefix(error.message || ''));
  const firstNewline = boundedMessage.indexOf('\n');
  const message = firstNewline === -1 ? boundedMessage : boundedMessage.slice(0, firstNewline);
  if (!source.lines.length && !message)
    return;
  // The pinned splice clamps caret placement to the frame end when the source has shrunk.
  const caretIndex = Math.min(location.line - source.start, source.lines.length);
  let emittedLines = 0;
  const appendFrameLine = (line: string) => {
    if (emittedLines++)
      markdown.append('\n');
    markdown.append(line);
  };
  markdown.append('\n\n# Test source\n\n```ts\n');
  for (let index = 0; index <= source.lines.length && !markdown.truncated; index++) {
    if (index === caretIndex && message)
      appendFrameLine(`${' '.repeat(width + 2)} | ${' '.repeat(Math.max(0, location.column - 2))} ^ ${message}`);
    if (index < source.lines.length) {
      const lineNumber = source.start + index + 1;
      appendFrameLine(`${lineNumber === location.line ? '> ' : '  '}${String(lineNumber).padEnd(width, ' ')} | ${source.lines[index]!}`);
    }
  }
  markdown.append('\n```');
}
