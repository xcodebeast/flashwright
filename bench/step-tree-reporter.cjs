// Prints the full step tree (fixtures included) of one test, for setup attribution.
const { writeFileSync } = require('node:fs');
class StepTreeReporter {
  constructor() { this.lines = []; }
  onTestEnd(test, result) {
    if (test.title !== (process.env.STEP_TREE_TEST || 'noop 5'))
      return;
    const visit = (steps, depth) => { for (const s of steps) { this.lines.push(`${'  '.repeat(depth)}${String(s.duration).padStart(4)} [${s.category}] ${s.title}`); visit(s.steps, depth + 1); } };
    visit(result.steps, 0);
    this.lines.push(`total ${result.duration}`);
  }
  onExit() { writeFileSync(process.env.STEP_OUT + '.tree', this.lines.join('\n') + '\n'); }
}
module.exports = StepTreeReporter;
