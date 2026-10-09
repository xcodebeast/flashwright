import type { EngineClient } from './client.js';
import type { Page } from './index.js';
import { failure, FlashwrightError } from './errors.js';
import { instrumentTraceMethods, tracePageOwner } from './trace-hooks.js';
import type { Tracing } from './tracing.js';

export type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload';

/** Metadata and browser identity belong to one modal occurrence, including after its page closes. */
export class Dialog {
  static {
    instrumentTraceMethods(this.prototype, 'Dialog', dialog => dialog.contextTracing
      ? { tracing: dialog.contextTracing(), pageId: dialog.pageIdentifier }
      : dialog.owner ? tracePageOwner(dialog.owner) : undefined, {
      accept: { parameters: ['promptText'], capture: 'metadata-only' }, dismiss: { capture: 'metadata-only' },
    });
  }
  private handled = false;
  private terminalError: FlashwrightError | undefined;
  constructor(
    private readonly owner: Page | null,
    private readonly client: EngineClient,
    private readonly pageIdentifier: string,
    private readonly identifier: string,
    private readonly dialogType: DialogType,
    private readonly dialogMessage: string,
    private readonly dialogDefaultValue: string,
    private readonly contextTracing?: () => Tracing,
  ) {}
  page(): Page | null { return this.owner; }
  type(): string { return this.dialogType; }
  message(): string { return this.dialogMessage; }
  defaultValue(): string { return this.dialogDefaultValue; }
  async accept(promptText?: string): Promise<void> {
    if (promptText !== undefined && typeof promptText !== 'string') throw failure('InvalidArgumentError', 'dialog.accept', 'promptText must be a string');
    await this.handle('dialog.accept', promptText);
  }
  async dismiss(): Promise<void> {
    try { await this.handle('dialog.dismiss'); }
    catch (error) { if (!(error instanceof Error) || error.name !== 'TargetClosedError') throw error; }
  }
  private async handle(method: 'dialog.accept' | 'dialog.dismiss', promptText?: string): Promise<void> {
    if (this.owner?.isClosed()) throw failure('TargetClosedError', method, 'page is closed');
    if (this.terminalError) throw failure('TargetClosedError', method, this.terminalError.details.message);
    if (this.handled) throw failure('ProtocolError', method, 'Cannot handle dialog which is already handled!');
    this.handled = true;
    try {
      await this.client.request(method, { page: this.pageIdentifier, dialog: this.identifier, ...(promptText === undefined ? {} : { promptTextJson: JSON.stringify(promptText) }) });
    } catch (error) {
      if (error instanceof FlashwrightError) {
        if (error.name === 'TargetClosedError') this.terminalError = error;
        // The public object remains consumed even when admission failed before native claim.
        if (error.name === 'ResourceLimitError' && !error.details.cleanup) {
          try {
            await this.client.request('page.close', { page: this.pageIdentifier }, 500);
            error.details.cleanup = 'pageClosedAfterDialogAdmissionFailure';
          } catch {
            error.details.cleanup = 'guardianContinuingCleanup';
            this.client.rejectProtocol(error);
          }
        }
      }
      throw error;
    }
  }
}

export function receivedDialog(owner: Page | null, client: EngineClient, parameters: unknown, contextTracing?: () => Tracing): Dialog {
  const payload = parameters as { page?: unknown; dialog?: unknown; dialogJson?: unknown } | null;
  if (!payload || typeof payload.page !== 'string' || typeof payload.dialog !== 'string' || typeof payload.dialogJson !== 'string') throw failure('ProtocolError', 'dialog', 'driver omitted original dialog identity');
  const metadata = JSON.parse(payload.dialogJson);
  if (!metadata || !['alert', 'confirm', 'prompt', 'beforeunload'].includes(metadata.type) || typeof metadata.message !== 'string' || (metadata.defaultPrompt !== undefined && typeof metadata.defaultPrompt !== 'string')) throw failure('ProtocolError', 'dialog', 'driver omitted dialog metadata');
  return new Dialog(owner, client, payload.page, payload.dialog, metadata.type, metadata.message, metadata.defaultPrompt ?? '', contextTracing);
}

/** Event delivery may race listener removal; defaults must still release the original modal. */
export function handleUnobservedDialog(dialog: Dialog, client: EngineClient): void {
  void (dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()).catch(error => {
    if (!(error instanceof FlashwrightError) || !error.details.cleanup) client.rejectProtocol(error);
  });
}
