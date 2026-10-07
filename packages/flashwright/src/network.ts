import type { EngineClient } from './client.js';
import { failure } from './errors.js';

export interface RequestMetadata {
  identifier: string; identity: string; url: string; method: string; headers: Record<string, string>;
  postData: string | null; resourceType: string; navigation: boolean; frame: string | null;
}
export interface ResponseMetadata {
  identifier: string; url: string; status: number; statusText: string; headers: Record<string, string>;
  request: RequestMetadata; fromServiceWorker: boolean;
}

function headers(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name.toLowerCase(), String(value)]));
}

/** Public network metadata remains usable after its page closes. */
export class Request {
  private responseValue: Response | null = null;
  private failureText: string | null = null;
  private finished = false;
  private resolveResponse!: (response: Response | null) => void;
  private readonly responseReady = new Promise<Response | null>(resolve => { this.resolveResponse = resolve; });
  constructor(readonly metadata: RequestMetadata) {}
  url(): string { return this.metadata.url; }
  method(): string { return this.metadata.method; }
  headers(): Record<string, string> { return headers(this.metadata.headers); }
  async allHeaders(): Promise<Record<string, string>> { return this.headers(); }
  async headerValue(name: string): Promise<string | null> { return this.headers()[name.toLowerCase()] ?? null; }
  postData(): string | null { return this.metadata.postData ?? null; }
  postDataBuffer(): Buffer | null { const data = this.postData(); return data === null ? null : Buffer.from(data); }
  resourceType(): string { return this.metadata.resourceType.toLowerCase(); }
  isNavigationRequest(): boolean { return this.metadata.navigation; }
  async response(): Promise<Response | null> { return this.responseReady; }
  failure(): { errorText: string } | null { return this.failureText ? { errorText: this.failureText } : null; }
  didRespond(response: Response): void { this.responseValue = response; this.resolveResponse(response); }
  didFail(errorText: string): void { if (!this.finished) this.failureText = errorText; this.didFinish(); }
  didFinish(): void { this.finished = true; this.resolveResponse(this.responseValue); }
}

export class Response {
  constructor(private readonly client: EngineClient, private readonly pageIdentifier: string, private readonly metadata: ResponseMetadata, private readonly requestValue: Request) { requestValue.didRespond(this); }
  url(): string { return this.metadata.url; }
  status(): number { return this.metadata.status; }
  statusText(): string { return this.metadata.statusText; }
  ok(): boolean { return this.status() === 0 || this.status() >= 200 && this.status() <= 299; }
  headers(): Record<string, string> { return headers(this.metadata.headers); }
  async allHeaders(): Promise<Record<string, string>> { return this.headers(); }
  async headerValue(name: string): Promise<string | null> { return this.headers()[name.toLowerCase()] ?? null; }
  request(): Request { return this.requestValue; }
  fromServiceWorker(): boolean { return this.metadata.fromServiceWorker ?? false; }
  async body(): Promise<Buffer> {
    if (this.status() >= 300 && this.status() < 400 && this.headers().location) throw failure('ProtocolError', 'response.body', 'response body is unavailable for redirect responses');
    const result = await this.client.request('response.body', { page: this.pageIdentifier, request: this.metadata.identifier });
    if (!result || typeof result !== 'object' || !('body' in result) || typeof result.body !== 'string' || !('base64Encoded' in result) || typeof result.base64Encoded !== 'boolean') throw failure('ProtocolError', 'response.body', 'driver returned an invalid response body');
    return Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8');
  }
  async text(): Promise<string> { return (await this.body()).toString('utf8'); }
  async json(): Promise<any> { return JSON.parse(await this.text()); }
}
