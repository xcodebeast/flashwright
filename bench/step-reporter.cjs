// Prints step timings for every test: category, title, duration; plus process-relative milestones.
const { writeFileSync } = require('node:fs');
const t0 = Number(process.env.BENCH_T0 || Date.now());
const since = () => Date.now() - t0;
class StepReporter {
  constructor() { this.lines = [`reporter constructed +${since()}`]; }
  onBegin() { this.lines.push(`onBegin +${since()}`); }
  onTestBegin(test) { this.lines.push(`TEST ${test.title} +${since()}`); }
  onStepEnd(test, result, step) { if (step.parent) return; this.lines.push(`  ${String(step.duration).padStart(4)} [${step.category}] ${step.title}`); }
  onTestEnd(test, result) { this.lines.push(`END ${result.duration} +${since()}`); }
  onEnd() { this.lines.push(`onEnd +${since()}`); }
  async onExit() { this.lines.push(`onExit +${since()}`); writeFileSync(process.env.STEP_OUT, this.lines.join('\n') + '\n'); }
}
module.exports = StepReporter;
