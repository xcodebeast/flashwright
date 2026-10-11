import { failure, type APIRequestContext } from '@flashwright/core';

interface RequestCreation {
  readonly completion: Promise<void>;
  complete(): void;
  readonly disposeOptions: { reason?: string };
  context?: APIRequestContext;
  disposal?: Promise<void>;
}

/** A dependency enters use(owner) before creation starts, so setup timeout still has teardown custody. */
export class RequestFixtureOwner {
  private accepting = true;
  private readonly creations = new Set<RequestCreation>();
  private readonly contextCreations = new WeakMap<APIRequestContext, RequestCreation>();
  private retirement: Promise<void> | undefined;

  assertOpen(): void {
    if (!this.accepting) throw failure('TargetClosedError', 'runner.request', 'request fixture owner has retired');
  }

  async createContext(create: () => Promise<APIRequestContext>, disposeOptions: { reason?: string } = {}): Promise<APIRequestContext> {
    this.assertOpen();
    let complete!: () => void;
    const completion = new Promise<void>(resolve => { complete = resolve; });
    const creation: RequestCreation = { completion, complete, disposeOptions: { ...disposeOptions } };
    this.creations.add(creation);
    try {
      const context = await create();
      creation.context = context;
      this.contextCreations.set(context, creation);
      if (!this.accepting) {
        await this.disposeCreation(creation);
        throw failure('TargetClosedError', 'runner.request', 'request context completed after its fixture owner retired');
      }
      return context;
    } finally { creation.complete(); }
  }

  disposeContext(context: APIRequestContext): Promise<void> {
    const creation = this.contextCreations.get(context);
    if (!creation) throw failure('ProtocolError', 'runner.request', 'request context does not belong to this fixture owner');
    return this.disposeCreation(creation);
  }

  private disposeCreation(creation: RequestCreation): Promise<void> {
    if (!creation.context) throw failure('ProtocolError', 'runner.request', 'request creation has no published native context');
    return creation.disposal ??= creation.context.dispose(creation.disposeOptions);
  }

  retire(): Promise<void> {
    this.accepting = false;
    return this.retirement ??= (async () => {
      const results = await Promise.allSettled([...this.creations].map(async creation => {
        await creation.completion;
        if (creation.context) await this.disposeCreation(creation);
      }));
      this.creations.clear();
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (rejected) throw rejected.reason;
    })();
  }
}
