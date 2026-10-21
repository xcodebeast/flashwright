import { groupTests } from './suite-groups.js';
import { SuiteWorker, type PhaseFailure } from './suite-runtime.js';
import { processPlan, failure, type ProcessSuiteModule, type RunRequest } from './process-protocol.js';
import { observeDeadlines } from './deadlines.js';

async function send(message: unknown): Promise<void> {
  if (!process.send) throw new Error('Independent worker requires IPC');
  await new Promise<void>((resolve, reject) => process.send!(message, undefined, {}, (error: Error | null) => error ? reject(error) : resolve()));
}
async function main(): Promise<void> {
  const [modulePath, count, index, slot, timeout] = process.argv.slice(2);
  if (!modulePath) throw new Error('Missing suite module');
  const info = { workerIndex: Number(index), parallelIndex: Number(slot) };
  process.env.TEST_WORKER_INDEX = String(info.workerIndex); process.env.TEST_PARALLEL_INDEX = String(info.parallelIndex);
  // The module provides its loader boundary. Bun asynchronous import currently
  // loses collection ALS; synchronous test loading is the verified path.
  const loaded = require(modulePath) as ProcessSuiteModule;
  if (typeof loaded.loadSuite !== 'function') throw new Error('Suite module must export loadSuite');
  const tests = await loaded.loadSuite(info), groups = groupTests(tests, Number(count));
  const plan = processPlan(tests, groups);
  let worker: SuiteWorker | undefined, workerKey: number | undefined, busy = false, retiring = false;
  let activeToken: number | undefined;
  observeDeadlines(notice => { void send({ type: 'deadline', token: activeToken, notice }).catch(() => process.exit(1)); });
  const finish = async (): Promise<void> => {
    if (retiring) return;
    retiring = true;
    const errors: PhaseFailure[] = [...await worker?.close() ?? []];
    try { await loaded.onWorkerEnd?.(errors); } catch (error) { errors.push({ phase: 'workerTeardown', error }); }
    await send({ type: 'closed', errors: errors.map(e => failure(e.error, e.phase)) });
    process.exit(0);
  };
  process.on('message', message => {
    void (async () => {
      if (busy || retiring) throw new Error('Concurrent or retired worker command');
      const request = message as RunRequest | { type: 'close' };
      if (request.type === 'close') { await finish(); return; }
      if (request.type !== 'run') throw new Error('Unknown worker command');
      busy = true;
      activeToken = request.token;
      const group = groups[request.group], planned = plan.groups[request.group];
      if (!group || !planned) throw new Error('Unknown suite group');
      if (workerKey !== undefined && workerKey !== planned.workerKey) throw new Error('Incompatible worker group');
      const attempts = new Map(request.attempts.map(a => [a.id, a.retry]));
      const selected = group.tests.filter(t => attempts.has(t.id));
      if (!selected.length || selected.length !== request.attempts.length || request.attempts.some(a => !Number.isSafeInteger(a.retry) || a.retry < 0)) throw new Error('Invalid group attempts');
      worker ??= new SuiteWorker(group.workerPool, info, Number(timeout ?? 30000)); workerKey = planned.workerKey;
      const result = await worker.run(selected, {
        retries: attempts,
        onBegin: async (test, current) => {
          await send({ type: 'begin', token: request.token, id: test.id, retry: current.retry });
          await loaded.onBegin?.(test, current);
        },
        onResult: async result => {
          await send({ type: 'result', token: request.token, result: {
            id: result.test.id, retry: attempts.get(result.test.id), status: result.status, expectedStatus: result.expectedStatus,
            ...info, errors: result.errors.map(e => failure(e.error, e.phase)), duration: result.finished - result.started,
          } });
          await loaded.onResult?.(result);
        },
      });
      const skipIds = result.failedBeforeAll ? result.pending.filter(t => t.suites.includes(result.failedBeforeAll!)).map(t => t.id) : [];
      busy = false;
      await send({ type: 'done', token: request.token, workerStopped: result.workerStopped, pending: result.pending.map(t => t.id), skipIds });
      activeToken = undefined;
    })().catch(async error => { try { await send({ type: 'fatal', error: failure(error, 'worker') }); } finally { process.exit(1); } });
  });
  process.on('disconnect', () => { process.exit(1); });
  await send({ type: 'ready', plan });
}
if (require.main === module) void main().catch(async error => { try { await send({ type: 'fatal', error: failure(error, 'collection') }); } finally { process.exit(1); } });
