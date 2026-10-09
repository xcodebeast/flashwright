import type { EngineClient } from './client.js';
import type { Page } from './index.js';
import { ElementHandle, receivedHandles } from './handles.js';
import { failure } from './errors.js';
import type { InputFiles, SetInputFilesOptions } from './file-inputs.js';
import { instrumentTraceMethods, tracePageOwner } from './trace-hooks.js';

/** A chooser's element is the original utility-world node, even after DOM replacement. */
export class FileChooser {
  static { instrumentTraceMethods(this.prototype, 'FileChooser', chooser => tracePageOwner(chooser.owner), { setFiles: { method: 'setInputFiles', parameters: ['files', 'options'] } }); }
  constructor(private readonly owner: Page, private readonly input: ElementHandle<HTMLInputElement>, private readonly multiple: boolean) {}
  page(): Page { return this.owner; }
  element(): ElementHandle<HTMLInputElement> { return this.input; }
  isMultiple(): boolean { return this.multiple; }
  setFiles(files: InputFiles, options: SetInputFilesOptions = {}): Promise<void> { return this.input.setInputFiles(files, options); }
}

export function fileChooser(owner: Page, client: EngineClient, page: string, parameters: unknown): FileChooser {
  if (!parameters || typeof parameters !== 'object' || !('multiple' in parameters) || typeof parameters.multiple !== 'boolean') throw failure('ProtocolError', 'filechooser', 'driver omitted file chooser multiplicity');
  const handles = receivedHandles(owner, client, page, parameters);
  if (handles.length !== 1 || !(handles[0]!.handle instanceof ElementHandle)) throw failure('ProtocolError', 'filechooser', 'driver omitted a unique file chooser element');
  return new FileChooser(owner, handles[0]!.handle as ElementHandle<HTMLInputElement>, parameters.multiple);
}
