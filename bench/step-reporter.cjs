// Prints step timings for every test: category, title, duration.
const { writeFileSync } = require('node:fs');
class StepReporter {
  constructor() { this.lines = []; this.t0 = Date.now(); }
  onBegin() { this.lines.push(`onBegin +${Date.now() - this.t0}`); }
  onTestBegin(test) { this.lines.push(`TEST ${test.title} +${Date.now() - this.t0}`); }
  onStepEnd(test, result, step) { if (step.parent) return; this.lines.push(`  ${String(step.duration).padStart(4)} [${step.category}] ${step.title}`); }
  onTestEnd(test, result) { this.lines.push(`END ${result.duration} +${Date.now() - this.t0}`); }
  onEnd() { this.lines.push(`onEnd +${Date.now() - this.t0}`); writeFileSync(process.env.STEP_OUT, this.lines.join('\n') + '\n'); }
}
module.exports = StepReporter;
