import type { BrowserContext, Disposable, Page, Request, Route, RouteContinueOptions, RouteFulfillOptions } from 'flashwright';

async function checkRoutingTypes(page: Page, context: BrowserContext) {
  const continued: RouteContinueOptions = { headers: { Removed: undefined }, postData: { message: 'json' } };
  const fulfilled: RouteFulfillOptions = { status: 201, json: false };
  const handler = async (route: Route, request: Request) => {
    const predecessor: Request | null = request.redirectedFrom();
    const successor: Request | null = request.redirectedTo();
    void predecessor; void successor; request.frame();
    await route.fallback(continued);
  };
  const registration: Disposable = await page.route('**/*', handler, { times: 1 });
  await registration.dispose(); await registration[Symbol.asyncDispose]();
  await context.route(/example/, route => route.fulfill(fulfilled));
  await context.unroute(/example/); await page.unroute('**/*', handler);
  await page.unrouteAll({ behavior: 'ignoreErrors' }); await context.unrouteAll({ behavior: 'wait' });
  // @ts-expect-error Response bodies accept strings and buffers.
  await page.route('**/*', route => route.fulfill({ body: 42 }));
  // @ts-expect-error Removal has three supported behaviors.
  await page.unrouteAll({ behavior: 'cancel' });
}
void checkRoutingTypes;
