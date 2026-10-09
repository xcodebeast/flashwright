const { test, phase } = require('./fixtures.cjs');
test.use({ userWorkerOption: async ({}, use) => {
  phase('failing worker option');
  throw new Error('original early worker fixture failure');
} });
test.fail();
test('early worker fixture failure', async () => { throw new Error('unreachable body'); });
