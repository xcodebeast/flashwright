const { test, phase, expect } = require('./fixtures.cjs');
test('ordinary first', async ({}, testInfo) => {
  phase('body');
  const bytes = Buffer.from('body snapshot');
  await testInfo.attach('body snapshot', { body: bytes, contentType: 'text/plain' });
  testInfo.attachments.find(item => item.name === 'body snapshot').body.fill(120);
  await test.step('nested user step', async () => { expect([1, 2]).toEqual([1, 2]); });
  process.stdout.write('adoption stdout marker\n');
  process.stderr.write(Buffer.from('adoption stderr marker\n'));
  testInfo.setTimeout(8765);
});
test('retry ownership', async ({}, testInfo) => {
  phase('retry body');
  await testInfo.attach('attempt body', { body: `attempt ${testInfo.retry}`, contentType: 'text/plain' });
  if (!testInfo.retry) throw new Error('intentional first-attempt failure');
});
test('expected failure', async () => { test.fail(); throw new Error('expected original error', { cause: new Error('expected original cause') }); });
test('ordinary successor', async () => { phase('successor body'); await test.step('successor step', async () => {}); });
test.skip('skipped final hook owner', async () => {});
