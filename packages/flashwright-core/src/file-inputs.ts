import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { failure } from './errors.js';
import { fileMimeType } from './file-mime-types.js';
import { validateBoolean, validateOptions } from './validation.js';
import { validateTimeout } from './waits.js';

export interface FilePayload { name: string; mimeType: string; buffer: Buffer }
export type InputFiles = string | readonly string[] | FilePayload | readonly FilePayload[];
export interface SetInputFilesOptions { timeout?: number; noWaitAfter?: boolean }
export interface FrameSetInputFilesOptions extends SetInputFilesOptions { strict?: boolean }
interface PayloadMetadata { name: number[]; mimeType: number[]; offset: number; length: number }
export type PreparedInputFiles = { files: { paths: string[] }; buffers?: never }
  | { files: { payloads: PayloadMetadata[] }; buffers: Buffer[] };
const maximumMetadataBytes = 1024 * 1024;
const maximumBufferBytes = 32 * 1024 * 1024;
const units = (value: string) => Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));

/** Validate every value before filesystem work; file contents stay owned by the browser. */
export async function prepareInputFiles(files: InputFiles, options: FrameSetInputFilesOptions, method: string, frame: boolean): Promise<PreparedInputFiles> {
  validateOptions(method, options, frame ? ['strict', 'timeout', 'noWaitAfter'] : ['timeout', 'noWaitAfter']);
  validateBoolean(`${method}.noWaitAfter`, options.noWaitAfter);
  if (frame) validateBoolean(`${method}.strict`, options.strict);
  if (options.timeout !== undefined) validateTimeout(options.timeout, method);
  const items = Array.isArray(files) ? files.slice() : [files];
  if (items.length > 4096) throw failure('ResourceLimitError', method, 'file upload exceeds 4096 files');
  let metadataBytes = 0;
  const accountMetadata = (length: number) => {
    metadataBytes += length * 2;
    if (metadataBytes > maximumMetadataBytes) throw failure('ResourceLimitError', method, 'file upload metadata exceeds 1 MiB');
  };
  if (items.some(item => typeof item === 'string')) {
    if (!items.every(item => typeof item === 'string')) throw failure('InvalidArgumentError', method, 'file paths cannot be mixed with buffers');
    const paths = (items as string[]).map(path => {
      if (!path || path.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(path)) throw failure('InvalidArgumentError', method, 'file path must be nonempty and representable by the filesystem');
      const absolute = resolve(path);
      if (absolute.length > 32768) throw failure('ResourceLimitError', method, 'file path exceeds 32768 UTF-16 units');
      accountMetadata(absolute.length);
      return absolute;
    });
    for (const path of paths) {
      let information;
      try { information = await stat(path); }
      catch (error) { throw failure('InvalidArgumentError', method, `cannot access upload file: ${(error as Error).message}`); }
      if (information.isDirectory()) throw failure('UnsupportedFeatureError', method, 'directory uploads are not implemented; pass individual files');
      if (!information.isFile()) throw failure('UnsupportedFeatureError', method, 'only regular upload files are supported');
    }
    return { files: { paths } };
  }
  const payloads: PayloadMetadata[] = [];
  const buffers: Buffer[] = [];
  let byteLength = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object') throw failure('InvalidArgumentError', method, 'expected a local path or FilePayload');
    validateOptions(method, item, ['name', 'mimeType', 'buffer']);
    if (typeof item.name !== 'string' || typeof item.mimeType !== 'string' || !Buffer.isBuffer(item.buffer)) throw failure('InvalidArgumentError', method, 'FilePayload requires string name, string mimeType and Buffer buffer');
    const mimeType = item.mimeType || fileMimeType(item.name);
    accountMetadata(item.name.length + mimeType.length);
    if (byteLength + item.buffer.byteLength > maximumBufferBytes) throw failure('ResourceLimitError', method, 'in-memory upload exceeds 32 MiB; pass local file paths for larger files');
    payloads.push({ name: units(item.name), mimeType: units(mimeType), offset: byteLength, length: item.buffer.byteLength });
    buffers.push(item.buffer);
    byteLength += item.buffer.byteLength;
  }
  return { files: { payloads }, buffers };
}

/** Selector encoding remains exact even for JavaScript strings containing lone surrogates. */
export function fileInputSelector(selector: string, method: string): number[] {
  if (typeof selector !== 'string') throw failure('InvalidArgumentError', method, 'selector must be a string');
  if (selector.length > 100000) throw failure('ResourceLimitError', method, 'selector exceeds 100000 UTF-16 units');
  return units(selector);
}
