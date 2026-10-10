module.exports = class InterruptionReporter {
  onStdOut(chunk) { process.stdout.write(chunk); }
  onBegin() { process.stdout.write(`FLASHWRIGHT_RUNNER_PROCESS=${process.pid}\n`); }
};
