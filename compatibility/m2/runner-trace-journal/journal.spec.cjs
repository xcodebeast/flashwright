const { _baseTest: base, expect } = require('playwright/test');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const { RunnerTraceJournal } = require(process.env.FLASHWRIGHT_JOURNAL_MODULE);
const adopted = new WeakSet();

/** Observe original pinned records in the same attempt; this is a comparison fixture, not the production adapter. */
async function observeJournal(testInfo) {
  const tracing = testInfo._tracing;
  if (adopted.has(tracing)) return;
  adopted.add(tracing);
  const options = tracing.traceOptions();
  const journal = await RunnerTraceJournal.create(tracing._contextCreatedEvent, options);
  for (const event of tracing._traceEvents.slice(1)) journal.append(event);
  let currentAttachments;
  const append = tracing._appendTraceEvent.bind(tracing);
  tracing._appendTraceEvent = event => {
    if (event.type === 'after') {
      const { attachments, ...metadata } = event;
      journal.append(metadata, currentAttachments);
    } else journal.append(event);
    append(event);
  };
  const appendAfter = tracing.appendAfterActionForStep.bind(tracing);
  tracing.appendAfterActionForStep = (callId, error, attachments, annotations) => {
    currentAttachments = attachments;
    try { appendAfter(callId, error, attachments, annotations); } finally { currentAttachments = undefined; }
  };
  const stop = tracing.stopIfNeeded.bind(tracing);
  tracing.stopIfNeeded = async () => {
    let archive;
    try {
      archive = await journal.takeArchive(testInfo.timeout, new AbortController().signal);
      const path = testInfo.outputPath('journal.zip');
      await archive.export(path, new AbortController().signal);
      await stop();
      await writeFile(testInfo.outputPath('comparison.json'), JSON.stringify({ reference: testInfo.outputPath('trace.zip'), journal: path, status: testInfo.status, title: testInfo.title, options }));
    } finally { await archive?.dispose(); await journal.dispose(); }
  };
}

const test = base.extend({
  trace: ['off', { scope: 'worker', option: true }],
  _observeJournal: [async ({}, use, testInfo) => { await observeJournal(testInfo); await use(); }, { auto: 'all-hooks-included' }],
  teardownAttachment: [async ({}, use, testInfo) => {
    await use();
    await testInfo.attach('fixture teardown', { body: 'final fixture bytes', contentType: 'text/plain' });
    testInfo.setTimeout(7654);
  }, { auto: true }],
});

test.beforeEach(async ({}, testInfo) => { await testInfo.attach('beforeEach', { body: 'before hook', contentType: 'text/plain' }); });
test.afterEach(async ({}, testInfo) => { await testInfo.attach('afterEach', { body: 'after hook', contentType: 'text/plain' }); });
test.beforeAll(async ({}, testInfo) => { await testInfo.attach('beforeAll', { body: 'first hook scope', contentType: 'text/plain' }); });
test.afterAll(async ({}, testInfo) => { await testInfo.attach('afterAll', { body: 'last hook scope', contentType: 'text/plain' }); });

test('mutation, file reads and final timeout', async ({}, testInfo) => {
  const source = testInfo.outputPath('sample-source.ts');
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, 'source before step\n');
  await test.step('source step', async () => {
    const attachment = Buffer.from('body before mutation');
    await testInfo.attach('mutable body', { body: attachment, contentType: 'text/plain' });
    testInfo.attachments.find(item => item.name === 'mutable body').body.fill(120);
    const file = testInfo.outputPath('input.txt');
    await writeFile(file, 'file before attachment');
    await testInfo.attach('mutable path', { path: file, contentType: 'text/plain' });
    await writeFile(testInfo.attachments.find(item => item.name === 'mutable path').path, 'file at final export');
    await testInfo.attach('empty body', { body: Buffer.alloc(0), contentType: 'application/octet-stream' });
    process.stdout.write('journal text output\n');
    process.stderr.write(Buffer.from([0x62, 0x69, 0x6e, 0xff, 0x0a]));
    testInfo.setTimeout(8888);
  }, { location: { file: source, line: 1, column: 1 } });
  await writeFile(source, Buffer.from([0x66, 0x69, 0x6e, 0x61, 0x6c, 0xff, 0xe2]));
  expect(await readFile(source)).toBeTruthy();
});

test('original failure through final hooks', async () => {
  test.fail();
  await test.step('failing step', async () => { throw new Error('original runner journal failure', { cause: new Error('original cause') }); });
});
