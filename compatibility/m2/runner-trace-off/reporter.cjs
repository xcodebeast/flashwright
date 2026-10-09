const { appendFileSync } = require('node:fs');
const record = event => appendFileSync(process.env.FLASHWRIGHT_TRACE_OFF_REPORTER, JSON.stringify(event) + '\n');
module.exports = class Reporter {
  onStepEnd(test, result, step) {
    record({ type: 'step', title: test.title, retry: result.retry, step: step.title, category: step.category, error: step.error });
  }
  onStdOut(chunk) { if (String(chunk).includes('trace-off stdout marker')) record({ type: 'stdout', text: String(chunk) }); }
  onStdErr(chunk) { if (String(chunk).includes('trace-off stderr marker')) record({ type: 'stderr', text: String(chunk) }); }
  onTestEnd(test, result) {
    record({ type: 'result', title: test.title, retry: result.retry, status: result.status, attachments: result.attachments.map(attachment => ({ name: attachment.name, contentType: attachment.contentType, body: attachment.body?.toString('base64'), path: attachment.path })) });
  }
};
