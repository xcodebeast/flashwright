// Reporter that prints, per worker, when each test began and ended (ms since process start).
const { writeFileSync } = require('node:fs');
const t0 = (() => {
  try {
    return Number(require('node:fs').readFileSync(process.env.STEP_OUT + '.t0', 'utf8'));
  } catch {
    return Date.now();
  }
})();
class WorkerTimeline {
  constructor() { this.lines = []; }
  onTestBegin(test, result) { this.lines.push({ worker: result.workerIndex, at: Date.now() - t0, kind: 'begin', title: test.title }); }
  onTestEnd(test, result) { this.lines.push({ worker: result.workerIndex, at: Date.now() - t0, kind: 'end', title: test.title, duration: result.duration }); }
  onEnd() { this.lines.push({ worker: -1, at: Date.now() - t0, kind: 'onEnd' }); }
  onExit() {
    const byWorker = new Map();
    for (const l of this.lines) { if (!byWorker.has(l.worker)) byWorker.set(l.worker, []); byWorker.get(l.worker).push(l); }
    const out = [];
    for (const [w, ls] of [...byWorker].sort((a, b) => a[0] - b[0])) out.push(`worker ${w}: ` + ls.map(l => l.kind === 'begin' ? `[${l.at}` : l.kind === 'end' ? `${l.at}](${l.duration})` : `onEnd ${l.at}`).join(' '));
    writeFileSync(process.env.STEP_OUT + '.workers', out.join('\n') + '\n');
  }
}
module.exports = WorkerTimeline;
